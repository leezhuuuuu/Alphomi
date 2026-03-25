import { BrowserWindow, ipcMain, WebContents } from 'electron'
import axios from 'axios'
import { randomUUID } from 'crypto'
import { TeachingActionType, TeachingStore, TeachingTimelineItem } from './teaching-store'
import {
  getActiveTabInfo,
  getActiveWebContents,
  registerUserDataActivityHandler,
  selectTabById,
} from './browser-view'

type TeachingEventPayload = {
  kind?: string
  summary?: string
  url?: string
  title?: string
  tabId?: number | null
  ts?: number
  target?: Record<string, unknown>
  detail?: Record<string, unknown>
}

type TeachingCaptureDeps = {
  getDriverBaseUrl: () => string | null
  getDriverSessionId: () => string | null
  sendToRenderer: (channel: string, payload: unknown) => void
}

const TEACHING_CONSOLE_PREFIX = '__ALPHOMI_TEACHING_EVENT__'
const TEACHING_EVENT_CHANNEL = 'teaching-event'
const TEACHING_STATE_CHANNEL = 'teaching-state'
const TEACHING_ERROR_CHANNEL = 'teaching-error'
const CAPTURE_DEBOUNCE_MS = 650
const INPUT_DEBOUNCE_MS = 420

const nowIso = () => new Date().toISOString()

function isInternalTeachingUrl(url?: string) {
  if (!url) return true
  return (
    url.startsWith('app://') ||
    url.startsWith('report://') ||
    url.startsWith('devtools://') ||
    url.startsWith('file://')
  )
}

function safeString(value: unknown, fallback = '') {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return fallback
  try {
    return String(value)
  } catch {
    return fallback
  }
}

function sanitizeSummary(text: string, fallback: string) {
  const cleaned = safeString(text, fallback)
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}

function normalizeActionType(kind: string | undefined): TeachingActionType | 'tab_switch_ignored' {
  switch (kind) {
    case 'click':
    case 'input':
    case 'change':
    case 'submit':
    case 'navigate':
    case 'navigate_in_page':
    case 'load':
    case 'tab_select':
      return kind
    case 'tab_switch_ignored':
      return kind
    default:
      return 'click'
  }
}

function formatActionSummary(payload: TeachingEventPayload): string {
  if (payload.summary) return sanitizeSummary(payload.summary, 'Captured action')

  const kind = payload.kind || 'event'
  const target = payload.target || {}
  const title = safeString(payload.title, '')
  const url = safeString(payload.url, '')
  const targetText = sanitizeSummary(
    [
      safeString(target.text, ''),
      safeString(target.label, ''),
      safeString(target.placeholder, ''),
      safeString(target.ariaLabel, ''),
      safeString(target.name, ''),
      safeString(target.id, ''),
    ]
      .filter(Boolean)
      .join(' · '),
    '',
  )

  if (kind === 'navigate') return `Navigated to ${url || title || 'page'}`
  if (kind === 'navigate_in_page') return `Changed in-page route to ${url || title || 'page'}`
  if (kind === 'load') return `Loaded ${url || title || 'page'}`
  if (kind === 'submit') return targetText ? `Submitted ${targetText}` : 'Submitted form'
  if (kind === 'input') return targetText ? `Typed into ${targetText}` : 'Edited input'
  if (kind === 'change') return targetText ? `Changed ${targetText}` : 'Changed form field'
  if (kind === 'tab_select') return `Activated tab ${payload.tabId ?? ''}`.trim()

  if (kind === 'click') {
    if (targetText) return `Clicked ${targetText}`
    if (url) return `Clicked element on ${url}`
    return 'Clicked element'
  }

  return sanitizeSummary(payload.summary || 'Captured action', 'Captured action')
}

function summarizeSnapshot(snapshot: string): string {
  const lines = String(snapshot || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)

  if (lines.length === 0) return 'Empty snapshot'

  const interesting: string[] = []
  let sawCurrent = false
  for (const line of lines) {
    if (line.startsWith('# Browser Tabs')) continue
    if (line.startsWith('# Current Page Content')) {
      sawCurrent = true
      continue
    }
    if (!sawCurrent) continue
    interesting.push(line)
    if (interesting.length >= 8) break
  }

  if (interesting.length === 0) {
    const fallback = lines.find((line) => line.startsWith('# Snapshot')) || lines[0]
    return sanitizeSummary(fallback, 'Snapshot captured')
  }

  return sanitizeSummary(interesting.join(' | '), 'Snapshot captured')
}

function buildArtifactMarkdown(input: {
  sessionId: string
  item: TeachingTimelineItem
  snapshot: string
  snapshotSummary: string
  driverSessionId: string
}) {
  return [
    '# Teaching Snapshot Artifact',
    `- sessionId: ${input.sessionId}`,
    `- itemId: ${input.item.id}`,
    `- itemKind: ${input.item.kind}`,
    `- actionType: ${input.item.actionType || 'n/a'}`,
    `- createdAt: ${input.item.createdAt}`,
    `- tabId: ${input.item.tabId ?? 'n/a'}`,
    `- url: ${input.item.url || 'n/a'}`,
    `- title: ${input.item.title || 'n/a'}`,
    `- driverSessionId: ${input.driverSessionId}`,
    '',
    '## Summary',
    input.snapshotSummary,
    '',
    '## Snapshot',
    '```text',
    input.snapshot || '',
    '```',
    '',
  ].join('\n')
}

class TeachingCaptureController {
  private readonly store = new TeachingStore()
  private readonly deps: TeachingCaptureDeps
  private activeSessionId: string | null = this.store.getActiveSessionId()
  private currentWebContents: WebContents | null = null
  private currentWebContentsId: number | null = null
  private restoreGuard = false
  private snapshotTimer: NodeJS.Timeout | null = null
  private pendingSnapshotItemId: string | null = null
  private pendingSnapshotReason: string | null = null
  private consoleListener: ((event: Electron.Event, level: number, message: string) => void) | null = null
  private domReadyListener: (() => void) | null = null
  private destroyedListener: (() => void) | null = null
  private attachedWc: WebContents | null = null
  private activityUnsubscribe: (() => void) | null = null

  constructor(deps: TeachingCaptureDeps) {
    this.deps = deps
    this.activityUnsubscribe = registerUserDataActivityHandler((activity) => {
      void this.handleBrowserViewActivity(activity)
    })
    this.registerIpcHandlers()
    this.syncFromStore()
  }

  dispose() {
    if (this.activityUnsubscribe) {
      this.activityUnsubscribe()
      this.activityUnsubscribe = null
    }
    this.clearSnapshotTimer()
    this.detachCurrentWebContents()
  }

  registerIpcHandlers() {
    ipcMain.handle('teaching-start', async () => this.startTeaching())
    ipcMain.handle('teaching-stop', async () => this.stopTeaching())
    ipcMain.handle('teaching-note', async (_, payload) => this.appendTeachingNote(payload))
    ipcMain.handle('teaching-get-state', async () => this.getState())
  }

  private syncFromStore() {
    const activeSession = this.store.getActiveSession()
    this.activeSessionId = activeSession?.id || null
    this.emitState()
  }

  getState() {
    const snapshot = this.store.buildSnapshot()
    return {
      ...snapshot,
      runtime: {
        attachedWebContentsId: this.currentWebContentsId,
        pendingSnapshotItemId: this.pendingSnapshotItemId,
        pendingSnapshotReason: this.pendingSnapshotReason,
        lockedTabActive:
          !!snapshot.activeSession &&
          !!getActiveTabInfo() &&
          snapshot.activeSession.lockedTabId === getActiveTabInfo()!.id,
      },
    }
  }

  async startTeaching() {
    const activeTab = getActiveTabInfo()
    if (!activeTab) {
      throw new Error('No active browser tab to teach from.')
    }
    if (isInternalTeachingUrl(activeTab.url)) {
      throw new Error('Teaching only supports browser content tabs.')
    }

    const current = this.store.getActiveSession()
    if (current && current.status === 'recording') {
      this.activeSessionId = current.id
      await this.syncActiveTab({ forceSelectLockedTab: true })
      this.emitState()
      return this.getState()
    }

    const session = this.store.createSession({
      lockedTabId: activeTab.id,
      lockedTabTitle: activeTab.title,
      lockedTabUrl: activeTab.url,
    })
    this.activeSessionId = session.id
    this.emitSessionEvent('session_start', {
      sessionId: session.id,
      tabId: activeTab.id,
      url: activeTab.url,
      title: activeTab.title,
    })
    await this.syncActiveTab({ forceSelectLockedTab: true })
    this.emitState()
    return this.getState()
  }

  async stopTeaching() {
    const session = this.getActiveSession()
    if (!session) {
      return this.getState()
    }
    this.appendSystemEvent(session.id, 'session_stop', 'Teaching stopped by user.')
    this.clearSnapshotTimer()
    await this.flushPendingSnapshot(true)
    this.store.updateSession(session.id, {
      status: 'stopped',
      stoppedAt: nowIso(),
    })
    this.activeSessionId = session.id
    this.detachCurrentWebContents()
    this.emitState()
    return this.getState()
  }

  async appendTeachingNote(payload: unknown) {
    const session = this.getActiveSession()
    if (!session || session.status !== 'recording') {
      throw new Error('No active teaching session.')
    }
    const note =
      typeof payload === 'string'
        ? payload
        : typeof payload === 'object' && payload !== null && 'text' in payload
          ? safeString((payload as { text?: unknown }).text, '')
          : ''
    if (!note.trim()) {
      return this.getState()
    }
    const item = this.store.appendNote(session.id, note.trim())
    if (item) {
      this.emitTimelineItem(session.id, item)
    }
    return this.getState()
  }

  onDriverSessionReady() {
    if (!this.getActiveSession()) return
    void this.syncActiveTab({ forceSelectLockedTab: true })
    void this.flushPendingSnapshot(false)
  }

  private getActiveSession() {
    if (!this.activeSessionId) return null
    const session = this.store.getSession(this.activeSessionId)
    if (session) return session
    const active = this.store.getActiveSession()
    if (active) {
      this.activeSessionId = active.id
      return active
    }
    return null
  }

  private emitToRenderer(channel: string, payload: unknown) {
    this.deps.sendToRenderer(channel, payload)
  }

  private emitState() {
    this.emitToRenderer(TEACHING_STATE_CHANNEL, this.getState())
  }

  private emitSessionEvent(type: string, payload: Record<string, unknown>) {
    this.emitToRenderer(TEACHING_EVENT_CHANNEL, {
      type,
      sessionId: this.activeSessionId,
      createdAt: nowIso(),
      ...payload,
    })
  }

  private emitTimelineItem(sessionId: string, item: TeachingTimelineItem) {
    this.emitToRenderer(TEACHING_EVENT_CHANNEL, {
      type: 'timeline_item',
      sessionId,
      item,
    })
    this.emitState()
  }

  private appendSystemEvent(sessionId: string, actionType: TeachingActionType | 'tab_switch_ignored' | 'session_start' | 'session_stop', summary: string, detail?: Record<string, unknown>) {
    const session = this.store.getSession(sessionId)
    if (!session) return null
    const item = this.store.appendTimelineItem(sessionId, {
      kind: 'system',
      tabId: session.lockedTabId,
      url: session.lockedTabUrl,
      title: session.lockedTabTitle,
      actionType: actionType === 'session_start' || actionType === 'session_stop'
        ? 'load'
        : actionType,
      summary,
      detail,
    })
    if (item) {
      this.emitTimelineItem(sessionId, item)
    }
    return item
  }

  private appendActionEvent(payload: TeachingEventPayload) {
    const session = this.getActiveSession()
    if (!session || session.status !== 'recording') return null
    const item = this.store.appendTimelineItem(session.id, {
      kind: 'action',
      tabId: typeof payload.tabId === 'number' ? payload.tabId : session.lockedTabId,
      url: payload.url || session.lockedTabUrl,
      title: payload.title || session.lockedTabTitle,
      actionType: normalizeActionType(payload.kind),
      summary: formatActionSummary(payload),
      detail: payload.detail || {
        kind: payload.kind,
        target: payload.target || null,
      },
    })
    if (item) {
      this.emitTimelineItem(session.id, item)
      this.scheduleSnapshot(item.actionType || payload.kind || 'click', item.id, false)
    }
    return item
  }

  private async handleBrowserViewActivity(activity: { reason: string; url?: string }) {
    const session = this.getActiveSession()
    if (!session || session.status !== 'recording') return

    const activeTab = getActiveTabInfo()
    if (!activeTab) return

    if (activeTab.id !== session.lockedTabId) {
      if (!this.restoreGuard) {
        this.restoreGuard = true
        this.appendSystemEvent(
          session.id,
          'tab_switch_ignored',
          `Ignored switch to tab ${activeTab.id}; teaching is locked to tab ${session.lockedTabId}.`,
          {
            reason: activity.reason,
            switchedTabId: activeTab.id,
            activeUrl: activity.url,
          },
        )
        selectTabById(session.lockedTabId)
        setTimeout(() => {
          this.restoreGuard = false
        }, 200)
      }
      return
    }

    this.attachActiveWebContents()

    const actionType = this.mapActivityReasonToActionType(activity.reason)
    const summary =
      activity.reason === 'load'
        ? `Loaded ${activity.url || activeTab.url}`
        : activity.reason === 'navigate'
          ? `Navigated to ${activity.url || activeTab.url}`
          : activity.reason === 'navigate-in-page'
            ? `In-page navigation to ${activity.url || activeTab.url}`
            : activity.reason === 'tab-select'
              ? `Activated teaching tab ${session.lockedTabId}`
              : `${activity.reason} on ${activity.url || activeTab.url}`

    const item = this.store.appendTimelineItem(session.id, {
      kind: 'action',
      tabId: activeTab.id,
      url: activeTab.url,
      title: activeTab.title,
      actionType,
      summary,
      detail: {
        reason: activity.reason,
        url: activity.url || activeTab.url,
      },
    })
    if (item) {
      this.emitTimelineItem(session.id, item)
      this.scheduleSnapshot(actionType, item.id, false)
    }
  }

  private mapActivityReasonToActionType(reason: string): TeachingActionType {
    switch (reason) {
      case 'navigate':
        return 'navigate'
      case 'navigate-in-page':
        return 'navigate_in_page'
      case 'load':
        return 'load'
      case 'tab-select':
        return 'tab_select'
      default:
        return 'navigate'
    }
  }

  private attachActiveWebContents() {
    const session = this.getActiveSession()
    if (!session || session.status !== 'recording') {
      this.detachCurrentWebContents()
      return
    }

    const activeTab = getActiveTabInfo()
    const wc = getActiveWebContents()
    if (!activeTab || !wc) {
      this.detachCurrentWebContents()
      return
    }

    if (activeTab.id !== session.lockedTabId) {
      this.detachCurrentWebContents()
      return
    }

    if (this.currentWebContents === wc && this.currentWebContentsId === wc.id) {
      void this.injectHooksIntoWebContents(wc)
      return
    }

    this.detachCurrentWebContents()
    this.currentWebContents = wc
    this.currentWebContentsId = wc.id

    this.consoleListener = (_event, _level, message) => {
      void this.handleConsoleMessage(wc, message)
    }
    this.domReadyListener = () => {
      void this.injectHooksIntoWebContents(wc)
    }
    this.destroyedListener = () => {
      if (this.currentWebContentsId === wc.id) {
        this.handleLockedTabDestroyed()
      }
    }

    wc.on('console-message', this.consoleListener)
    wc.on('dom-ready', this.domReadyListener)
    wc.on('did-finish-load', this.domReadyListener)
    wc.on('destroyed', this.destroyedListener)

    void this.injectHooksIntoWebContents(wc)
  }

  private detachCurrentWebContents() {
    if (!this.currentWebContents) return
    const wc = this.currentWebContents
    if (this.consoleListener) {
      wc.removeListener('console-message', this.consoleListener)
    }
    if (this.domReadyListener) {
      wc.removeListener('dom-ready', this.domReadyListener)
      wc.removeListener('did-finish-load', this.domReadyListener)
    }
    if (this.destroyedListener) {
      wc.removeListener('destroyed', this.destroyedListener)
    }
    this.currentWebContents = null
    this.currentWebContentsId = null
    this.consoleListener = null
    this.domReadyListener = null
    this.destroyedListener = null
  }

  private async injectHooksIntoWebContents(wc: WebContents) {
    const session = this.getActiveSession()
    if (!session || session.status !== 'recording') return
    const activeTab = getActiveTabInfo()
    if (!activeTab || activeTab.id !== session.lockedTabId) return
    if (wc.isDestroyed()) return

    const script = this.buildInjectedHookScript()
    try {
      await wc.executeJavaScript(script, true)
    } catch (error) {
      this.emitToRenderer(TEACHING_ERROR_CHANNEL, {
        message: 'Failed to inject teaching hooks into the active tab.',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private buildInjectedHookScript() {
    return `
      (() => {
        try {
          const PREFIX = ${JSON.stringify(TEACHING_CONSOLE_PREFIX)};
          if (window.__alphomiTeachingCaptureInstalled) return;
          window.__alphomiTeachingCaptureInstalled = true;

          const safeText = (value, fallback = '') => {
            if (typeof value === 'string') return value;
            if (value === null || value === undefined) return fallback;
            try { return String(value); } catch { return fallback; }
          };

          const clean = (value, limit = 140) => {
            const text = safeText(value, '').replace(/\\s+/g, ' ').trim();
            if (!text) return '';
            return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
          };

          const describeNode = (node) => {
            if (!node || !(node instanceof HTMLElement)) return {};
            const tag = (node.tagName || '').toLowerCase();
            const text = clean(node.innerText || node.textContent || '', 120);
            const value = 'value' in node ? clean(node.value, 140) : '';
            return {
              tagName: tag,
              id: clean(node.id, 80),
              name: clean(node.getAttribute('name'), 80),
              type: clean(node.getAttribute('type'), 40),
              role: clean(node.getAttribute('role'), 40),
              text,
              value,
              placeholder: clean(node.getAttribute('placeholder'), 120),
              ariaLabel: clean(node.getAttribute('aria-label'), 120),
              href: clean(node.getAttribute('href'), 180),
              checked: 'checked' in node ? Boolean(node.checked) : undefined,
              selected: 'selected' in node ? Boolean(node.selected) : undefined,
              disabled: 'disabled' in node ? Boolean(node.disabled) : undefined,
              contentEditable: clean(node.getAttribute('contenteditable'), 40),
            };
          };

          const buildSummary = (kind, target, extra = {}) => {
            const parts = [];
            const text = clean(target?.text || target?.ariaLabel || target?.placeholder || target?.name || target?.id || '', 120);
            const value = clean(target?.value || '', 120);
            const tag = clean(target?.tagName || '', 40);
            const href = clean(target?.href || '', 180);

            if (kind === 'click') {
              parts.push('Clicked');
              if (text) parts.push(text);
              else if (tag) parts.push(tag);
              if (href) parts.push('-> ' + href);
            } else if (kind === 'input') {
              parts.push('Input');
              if (text) parts.push(text);
              if (value) parts.push('= ' + value);
            } else if (kind === 'change') {
              parts.push('Changed');
              if (text) parts.push(text);
              if (value) parts.push('= ' + value);
            } else if (kind === 'submit') {
              parts.push('Submitted form');
              if (text) parts.push(text);
            } else if (kind === 'navigate_in_page') {
              parts.push('In-page navigation');
            } else {
              parts.push(clean(kind, 40) || 'Event');
            }

            if (extra && typeof extra === 'object') {
              const mode = clean(extra.mode || '', 40);
              if (mode) parts.push('[' + mode + ']');
            }
            return clean(parts.join(' '), 220) || 'Captured teaching event';
          };

          const emit = (payload) => {
            try {
              console.info(PREFIX + JSON.stringify(payload));
            } catch {}
          };

          const tabId = typeof window.__AI_BROWSER_TAB_ID === 'number' ? window.__AI_BROWSER_TAB_ID : null;
          const base = () => ({
            tabId,
            url: location.href,
            title: document.title,
            ts: Date.now(),
          });

          const emitDom = (kind, target, extra = {}) => {
            const detail = describeNode(target);
            const payload = {
              ...base(),
              kind,
              target: detail,
              detail,
              ...extra,
            };
            payload.summary = buildSummary(kind, detail, extra);
            emit(payload);
          };

          const inputTimers = new WeakMap();
          const queueInput = (event) => {
            const target = event?.target;
            if (!target || !(target instanceof HTMLElement)) return;
            const previous = inputTimers.get(target);
            if (previous) window.clearTimeout(previous);

            const delay = event.type === 'input' ? ${INPUT_DEBOUNCE_MS} : 0;
            const timer = window.setTimeout(() => {
              emitDom(event.type === 'input' ? 'input' : 'change', target, {
                mode: event.inputType || event.data || '',
              });
              inputTimers.delete(target);
            }, delay);

            inputTimers.set(target, timer);
          };

          document.addEventListener('click', (event) => {
            const target = event?.target;
            if (!target || !(target instanceof HTMLElement)) return;
            emitDom('click', target, {
              button: event.button,
            });
          }, true);

          document.addEventListener('input', queueInput, true);
          document.addEventListener('change', queueInput, true);
          document.addEventListener('submit', (event) => {
            const target = event?.target;
            if (!target || !(target instanceof HTMLElement)) return;
            emitDom('submit', target, {});
          }, true);

          window.addEventListener('hashchange', () => {
            emit({
              ...base(),
              kind: 'navigate_in_page',
              summary: buildSummary('navigate_in_page', {}, {}),
              detail: { source: 'hashchange' },
            });
          });

          window.addEventListener('popstate', () => {
            emit({
              ...base(),
              kind: 'navigate_in_page',
              summary: buildSummary('navigate_in_page', {}, {}),
              detail: { source: 'popstate' },
            });
          });

          const patchHistory = (method) => {
            const original = history[method];
            if (typeof original !== 'function') return;
            history[method] = function (...args) {
              const result = original.apply(this, args);
              window.setTimeout(() => {
                emit({
                  ...base(),
                  kind: 'navigate_in_page',
                  summary: buildSummary('navigate_in_page', {}, { mode: method }),
                  detail: { source: method, args: args.map((item) => clean(item, 120)) },
                });
              }, 0);
              return result;
            };
          };

          patchHistory('pushState');
          patchHistory('replaceState');
        } catch (error) {
          try {
            console.info(PREFIX + JSON.stringify({
              kind: 'error',
              summary: 'Failed to initialize teaching hooks',
              detail: { error: String(error) },
              ts: Date.now(),
              url: location.href,
              title: document.title,
              tabId: typeof window.__AI_BROWSER_TAB_ID === 'number' ? window.__AI_BROWSER_TAB_ID : null,
            }));
          } catch {}
        }
      })();
    `
  }

  private async handleConsoleMessage(wc: WebContents, message: string) {
    if (!message.startsWith(TEACHING_CONSOLE_PREFIX)) return
    const payloadRaw = message.slice(TEACHING_CONSOLE_PREFIX.length)
    let payload: TeachingEventPayload | null = null
    try {
      payload = JSON.parse(payloadRaw) as TeachingEventPayload
    } catch {
      return
    }

    const session = this.getActiveSession()
    if (!session || session.status !== 'recording') return
    if (wc.isDestroyed()) return

    const activeTab = getActiveTabInfo()
    if (!activeTab || activeTab.id !== session.lockedTabId) return

    const kind = safeString(payload.kind, 'click')
    const summary = sanitizeSummary(
      payload.summary || formatActionSummary(payload),
      'Captured action',
    )
    const item = this.store.appendTimelineItem(session.id, {
      kind: 'action',
      tabId: typeof payload.tabId === 'number' ? payload.tabId : session.lockedTabId,
      url: payload.url || activeTab.url,
      title: payload.title || activeTab.title,
      actionType: normalizeActionType(kind),
      summary,
      detail: {
        ...payload,
        consoleSource: true,
      },
    })

    if (item) {
      this.emitTimelineItem(session.id, item)
      this.scheduleSnapshot(item.actionType || kind || 'click', item.id, false)
    }
  }

  private handleLockedTabDestroyed() {
    const session = this.getActiveSession()
    if (!session) return
    this.appendSystemEvent(
      session.id,
      'tab_switch_ignored',
      'Locked teaching tab was destroyed; teaching capture interrupted.',
      { reason: 'destroyed' },
    )
    this.store.updateSession(session.id, {
      status: 'interrupted',
      stoppedAt: nowIso(),
    })
    this.detachCurrentWebContents()
    this.emitState()
  }

  private scheduleSnapshot(reason: string, itemId: string, immediate: boolean) {
    const session = this.getActiveSession()
    if (!session || session.status !== 'recording') return
    this.pendingSnapshotItemId = itemId
    this.pendingSnapshotReason = reason

    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer)
      this.snapshotTimer = null
    }

    const delay = immediate ? 0 : CAPTURE_DEBOUNCE_MS
    this.snapshotTimer = setTimeout(() => {
      void this.flushPendingSnapshot(false)
    }, delay)
  }

  private clearSnapshotTimer() {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer)
      this.snapshotTimer = null
    }
  }

  private async flushPendingSnapshot(force: boolean) {
    const session = this.getActiveSession()
    const itemId = this.pendingSnapshotItemId
    if (!session || session.status !== 'recording' || !itemId) return
    if (this.currentWebContents && this.currentWebContents.isDestroyed()) {
      this.detachCurrentWebContents()
    }

    if (this.pendingSnapshotReason === 'tab_switch_ignored' && !force) {
      return
    }

    const driverSessionId = this.deps.getDriverSessionId()
    const driverBaseUrl = this.deps.getDriverBaseUrl()
    if (!driverSessionId || !driverBaseUrl) {
      if (!force) {
        this.snapshotTimer = setTimeout(() => {
          void this.flushPendingSnapshot(false)
        }, 1500)
      }
      return
    }

    const item = session.timeline.find((entry) => entry.id === itemId)
    if (!item) {
      this.pendingSnapshotItemId = null
      this.pendingSnapshotReason = null
      return
    }

    try {
      const response = await axios.post(
        `${driverBaseUrl}/sessions/${driverSessionId}/tools/browser_snapshot`,
        { full: false, forceFullSnapshot: false },
        { timeout: 12000 },
      )
      const snapshot = safeString(response.data?.data?.snapshot ?? response.data?.snapshot ?? '', '')
      if (!snapshot.trim()) {
        this.pendingSnapshotItemId = null
        this.pendingSnapshotReason = null
        return
      }

      const snapshotSummary = summarizeSnapshot(snapshot)
      const artifactId = randomUUID()
      const markdown = buildArtifactMarkdown({
        sessionId: session.id,
        item,
        snapshot,
        snapshotSummary,
        driverSessionId,
      })
      const file = this.store.writeArtifactFile(session.id, artifactId, markdown)

      const artifact = this.store.attachArtifact(session.id, {
        id: artifactId,
        itemId: item.id,
        kind: 'snapshot_delta',
        path: file.path,
        summary: snapshotSummary,
        sizeBytes: file.sizeBytes,
      })

      if (artifact) {
        this.store.updateTimelineItem(session.id, item.id, {
          artifactId: artifact.id,
          detail: {
            ...(item.detail || {}),
            pageChangeSummary: snapshotSummary,
            artifactPath: artifact.path,
            artifactSizeBytes: artifact.sizeBytes,
          },
        })
      }

      const nextSession = this.getActiveSession()
      const updatedItem = nextSession?.timeline.find((entry) => entry.id === item.id) || item
      this.emitToRenderer(TEACHING_EVENT_CHANNEL, {
        type: 'artifact_captured',
        sessionId: session.id,
        item: updatedItem,
        artifact,
      })
      this.emitState()
    } catch (error) {
      this.emitToRenderer(TEACHING_ERROR_CHANNEL, {
        message: 'Teaching snapshot capture failed.',
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.pendingSnapshotItemId = null
      this.pendingSnapshotReason = null
      this.clearSnapshotTimer()
    }
  }

  private async syncActiveTab(options: { forceSelectLockedTab: boolean }) {
    const session = this.getActiveSession()
    if (!session || session.status !== 'recording') {
      this.detachCurrentWebContents()
      return
    }

    const activeTab = getActiveTabInfo()
    const wc = getActiveWebContents()
    if (!activeTab || !wc) {
      this.detachCurrentWebContents()
      return
    }

    if (activeTab.id !== session.lockedTabId) {
      this.detachCurrentWebContents()
      if (options.forceSelectLockedTab && !this.restoreGuard) {
        this.restoreGuard = true
        selectTabById(session.lockedTabId)
        setTimeout(() => {
          this.restoreGuard = false
        }, 200)
      }
      return
    }

    this.attachActiveWebContents()
  }
}

let teachingCaptureController: TeachingCaptureController | null = null

export function initializeTeachingCapture(deps: TeachingCaptureDeps) {
  if (!teachingCaptureController) {
    teachingCaptureController = new TeachingCaptureController(deps)
  }
  return teachingCaptureController
}

export function getTeachingCaptureController() {
  return teachingCaptureController
}
