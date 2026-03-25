import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

export type TeachingSessionStatus =
  | 'idle'
  | 'recording'
  | 'processing'
  | 'review'
  | 'stopped'
  | 'interrupted'
  | 'saved'

export type TeachingTimelineItemKind = 'action' | 'note' | 'system'

export type TeachingArtifactKind = 'snapshot_delta'

export type TeachingActionType =
  | 'click'
  | 'input'
  | 'change'
  | 'submit'
  | 'navigate'
  | 'navigate_in_page'
  | 'load'
  | 'tab_select'
  | 'tab_switch_ignored'

export type TeachingTimelineItem = {
  id: string
  kind: TeachingTimelineItemKind
  createdAt: string
  tabId: number | null
  url?: string
  title?: string
  actionType?: TeachingActionType
  summary: string
  detail?: Record<string, unknown>
  artifactId?: string | null
}

export type TeachingArtifact = {
  id: string
  sessionId: string
  itemId: string
  kind: TeachingArtifactKind
  path: string
  summary: string
  createdAt: string
  sizeBytes: number
}

export type TeachingSessionRecord = {
  id: string
  status: TeachingSessionStatus
  lockedTabId: number
  lockedTabTitle?: string
  lockedTabUrl?: string
  createdAt: string
  updatedAt: string
  startedAt: string
  stoppedAt?: string | null
  notes: string[]
  timeline: TeachingTimelineItem[]
  artifacts: TeachingArtifact[]
}

export type TeachingStoreSnapshot = {
  activeSessionId: string | null
  activeSession: TeachingSessionRecord | null
  sessions: TeachingSessionRecord[]
}

const STORE_VERSION = 1

const nowIso = () => new Date().toISOString()

function resolveTeachingRoot() {
  return path.join(app.getPath('userData'), 'teaching')
}

function resolveStorePath() {
  return path.join(resolveTeachingRoot(), 'teaching-store.json')
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback
    const raw = fs.readFileSync(filePath, 'utf8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeJsonFile(filePath: string, value: unknown) {
  ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, filePath)
}

function sanitizeTitle(value: string | undefined, fallback: string) {
  const cleaned = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}

type TeachingStoreFile = {
  version: number
  activeSessionId: string | null
  sessions: TeachingSessionRecord[]
}

export class TeachingStore {
  private readonly storePath: string
  private data: TeachingStoreFile

  constructor(storePath = resolveStorePath()) {
    this.storePath = storePath
    this.data = this.load()
  }

  private load(): TeachingStoreFile {
    const parsed = readJsonFile<TeachingStoreFile>(this.storePath, {
      version: STORE_VERSION,
      activeSessionId: null,
      sessions: [],
    })

    const sessions = Array.isArray(parsed.sessions)
      ? parsed.sessions.filter((item): item is TeachingSessionRecord => Boolean(item?.id))
      : []

    return {
      version: STORE_VERSION,
      activeSessionId:
        typeof parsed.activeSessionId === 'string' ? parsed.activeSessionId : null,
      sessions,
    }
  }

  private save() {
    writeJsonFile(this.storePath, this.data)
  }

  private findSessionIndex(sessionId: string) {
    return this.data.sessions.findIndex((session) => session.id === sessionId)
  }

  getStorePath() {
    return this.storePath
  }

  getActiveSessionId() {
    return this.data.activeSessionId
  }

  getSessions() {
    return this.data.sessions.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  getSession(sessionId: string | null | undefined) {
    if (!sessionId) return null
    return this.data.sessions.find((session) => session.id === sessionId) || null
  }

  getActiveSession() {
    return this.getSession(this.data.activeSessionId)
  }

  createSession(input: {
    lockedTabId: number
    lockedTabTitle?: string
    lockedTabUrl?: string
  }) {
    const id = randomUUID()
    const createdAt = nowIso()
    const record: TeachingSessionRecord = {
      id,
      status: 'recording',
      lockedTabId: input.lockedTabId,
      lockedTabTitle: input.lockedTabTitle,
      lockedTabUrl: input.lockedTabUrl,
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt,
      stoppedAt: null,
      notes: [],
      timeline: [],
      artifacts: [],
    }
    this.data.sessions.push(record)
    this.data.activeSessionId = id
    this.save()
    return record
  }

  setActiveSession(sessionId: string | null) {
    this.data.activeSessionId = sessionId
    this.save()
  }

  updateSession(
    sessionId: string,
    patch: Partial<Pick<
      TeachingSessionRecord,
      | 'status'
      | 'lockedTabId'
      | 'lockedTabTitle'
      | 'lockedTabUrl'
      | 'stoppedAt'
      | 'startedAt'
    >>,
  ) {
    const index = this.findSessionIndex(sessionId)
    if (index < 0) return null
    const current = this.data.sessions[index]
    const next: TeachingSessionRecord = {
      ...current,
      ...patch,
      updatedAt: nowIso(),
    }
    this.data.sessions[index] = next
    this.save()
    return next
  }

  appendNote(sessionId: string, note: string) {
    const text = sanitizeTitle(note, '')
    if (!text) return null
    return this.appendTimelineItem(sessionId, {
      kind: 'note',
      tabId: null,
      summary: text,
    })
  }

  appendTimelineItem(
    sessionId: string,
    input: Omit<TeachingTimelineItem, 'id' | 'createdAt'> & {
      id?: string
      createdAt?: string
    },
  ) {
    const index = this.findSessionIndex(sessionId)
    if (index < 0) return null
    const current = this.data.sessions[index]
    const item: TeachingTimelineItem = {
      id: input.id || randomUUID(),
      createdAt: input.createdAt || nowIso(),
      kind: input.kind,
      tabId: input.tabId ?? null,
      url: input.url,
      title: input.title,
      actionType: input.actionType,
      summary: sanitizeTitle(input.summary, ''),
      detail: input.detail,
      artifactId: input.artifactId ?? null,
    }
    if (!item.summary) return null
    current.timeline.push(item)
    current.updatedAt = nowIso()
    this.save()
    return item
  }

  updateTimelineItem(
    sessionId: string,
    itemId: string,
    patch: Partial<Omit<TeachingTimelineItem, 'id' | 'createdAt' | 'kind'>>,
  ) {
    const index = this.findSessionIndex(sessionId)
    if (index < 0) return null
    const current = this.data.sessions[index]
    const item = current.timeline.find((entry) => entry.id === itemId)
    if (!item) return null
    Object.assign(item, patch, { summary: sanitizeTitle(patch.summary ?? item.summary, item.summary) })
    current.updatedAt = nowIso()
    this.save()
    return item
  }

  attachArtifact(
    sessionId: string,
    input: Omit<TeachingArtifact, 'id' | 'createdAt' | 'sessionId'> & {
      id?: string
      createdAt?: string
    },
  ) {
    const index = this.findSessionIndex(sessionId)
    if (index < 0) return null
    const current = this.data.sessions[index]
    const artifact: TeachingArtifact = {
      id: input.id || randomUUID(),
      sessionId,
      itemId: input.itemId,
      kind: input.kind,
      path: input.path,
      summary: sanitizeTitle(input.summary, ''),
      createdAt: input.createdAt || nowIso(),
      sizeBytes: Math.max(0, Math.floor(input.sizeBytes || 0)),
    }
    current.artifacts.push(artifact)
    const item = current.timeline.find((entry) => entry.id === artifact.itemId)
    if (item) {
      item.artifactId = artifact.id
    }
    current.updatedAt = nowIso()
    this.save()
    return artifact
  }

  updateTimelineItemArtifact(sessionId: string, itemId: string, artifactId: string) {
    const index = this.findSessionIndex(sessionId)
    if (index < 0) return null
    const current = this.data.sessions[index]
    const item = current.timeline.find((entry) => entry.id === itemId)
    if (!item) return null
    item.artifactId = artifactId
    current.updatedAt = nowIso()
    this.save()
    return item
  }

  writeArtifactFile(sessionId: string, artifactId: string, content: string) {
    const artifactDir = path.join(resolveTeachingRoot(), 'sessions', sessionId, 'artifacts')
    ensureDir(artifactDir)
    const filePath = path.join(artifactDir, `${artifactId}.md`)
    fs.writeFileSync(filePath, content, 'utf8')
    return {
      path: filePath,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
    }
  }

  buildSnapshot() {
    const activeSession = this.getActiveSession()
    return {
      activeSessionId: this.data.activeSessionId,
      activeSession,
      sessions: this.getSessions(),
    } satisfies TeachingStoreSnapshot
  }
}
