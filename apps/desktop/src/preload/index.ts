import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 定义 Tab 类型
interface Tab {
  id: number
  title: string
  active: boolean
}

type LLMEndpointMode = 'auto' | 'chat_completions' | 'responses'

type TeachingTimelineItemKind = 'action' | 'note' | 'system'
type TeachingArtifactKind = 'snapshot_delta'
type TeachingActionType =
  | 'click'
  | 'input'
  | 'change'
  | 'submit'
  | 'navigate'
  | 'navigate_in_page'
  | 'load'
  | 'tab_select'
  | 'tab_switch_ignored'

type TeachingTimelineItem = {
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

type TeachingArtifact = {
  id: string
  sessionId: string
  itemId: string
  kind: TeachingArtifactKind
  path: string
  summary: string
  createdAt: string
  sizeBytes: number
}

type TeachingSessionRecord = {
  id: string
  status: 'idle' | 'recording' | 'processing' | 'review' | 'stopped' | 'interrupted' | 'saved'
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

type TeachingStateSnapshot = {
  activeSessionId: string | null
  activeSession: TeachingSessionRecord | null
  sessions: TeachingSessionRecord[]
  runtime: {
    attachedWebContentsId: number | null
    pendingSnapshotItemId: string | null
    pendingSnapshotReason: string | null
    lockedTabActive: boolean
  }
}

type TeachingEventPayload = {
  type: string
  sessionId?: string | null
  createdAt?: string
  item?: TeachingTimelineItem
  artifact?: TeachingArtifact
  message?: string
  error?: string
  [key: string]: unknown
}

// Custom APIs for renderer
const api = {
  navigate: (url: string) => ipcRenderer.send('navigate', url),
  resizeView: (bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.send('resize-view', bounds),
  // 新增标签页相关 API
  tabSelect: (id: number) => ipcRenderer.send('tab-select', id),
  tabClose: (id: number) => ipcRenderer.send('tab-close', id),
  tabNew: (url?: string) => ipcRenderer.send('tab-new', url),
  setTheme: (color: string) => ipcRenderer.send('ui-theme-set', color),
  setMode: (mode: 'light' | 'dark' | 'system') => ipcRenderer.send('ui-mode-set', mode),
  getSettings: () => ipcRenderer.invoke('settings-get'),
  updateSettings: (patch: {
    themeMode?: 'light' | 'dark' | 'system'
    newTabUrl?: string
    toolStates?: Record<string, boolean>
  }) =>
    ipcRenderer.invoke('settings-update', patch),
  getToolCatalog: () => ipcRenderer.invoke('settings-tool-catalog'),
  getLLMSettings: () => ipcRenderer.invoke('llm-settings-get'),
  updateLLMSettings: (patch: {
    activeProfileId?: string | null
    profiles?: {
      id?: string
      label?: string
      providerType?: 'openai_compatible'
      baseUrl?: string
      model?: string
      endpointMode?: LLMEndpointMode
      apiKey?: string
    }[]
  }) => ipcRenderer.invoke('llm-settings-update', patch),
  getEffectiveLLMSettings: (options?: { includeApiKey?: boolean }) =>
    ipcRenderer.invoke('llm-settings-effective', options),
  testLLMSettings: (input?: {
    profileId?: string | null
    baseUrl?: string
    model?: string
    endpointMode?: LLMEndpointMode
    apiKey?: string
  }) => ipcRenderer.invoke('llm-settings-test', input),
  openMenu: (anchor: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send('menu-open', anchor),
  menuAction: (action: string) => ipcRenderer.invoke('menu-action', action),
  getMenuState: () => ipcRenderer.invoke('menu-get-state'),

  // 新增导航控制
  goBack: () => ipcRenderer.send('go-back'),
  goForward: () => ipcRenderer.send('go-forward'),
  reload: () => ipcRenderer.send('reload'),
  stop: () => ipcRenderer.send('stop'),

  // 获取 Brain WebSocket URL
  getBrainUrl: () => ipcRenderer.invoke('get-brain-url'),

  // 教学采集
  teachingStart: () => ipcRenderer.invoke('teaching-start'),
  teachingStop: () => ipcRenderer.invoke('teaching-stop'),
  teachingAddNote: (payload: string | { text: string }) => ipcRenderer.invoke('teaching-note', payload),
  teachingGetState: () => ipcRenderer.invoke('teaching-get-state'),
  onTeachingEvent: (listener: (payload: TeachingEventPayload) => void) => {
    const handler = (_event: IpcRendererEvent, payload: TeachingEventPayload) => listener(payload)
    ipcRenderer.on('teaching-event', handler)
    return () => ipcRenderer.removeListener('teaching-event', handler)
  },
  onTeachingState: (listener: (payload: TeachingStateSnapshot) => void) => {
    const handler = (_event: IpcRendererEvent, payload: TeachingStateSnapshot) => listener(payload)
    ipcRenderer.on('teaching-state', handler)
    return () => ipcRenderer.removeListener('teaching-state', handler)
  },
  onTeachingError: (listener: (payload: { message: string; error?: string }) => void) => {
    const handler = (_event: IpcRendererEvent, payload: { message: string; error?: string }) =>
      listener(payload)
    ipcRenderer.on('teaching-error', handler)
    return () => ipcRenderer.removeListener('teaching-error', handler)
  },

  // 下载管理
  getDownloads: () => ipcRenderer.invoke('downloads-get'),
  downloadAction: (action: 'show' | 'open' | 'cancel', id: string) =>
    ipcRenderer.invoke('downloads-action', action, id),

  // Render page export
  renderExport: (payload: {
    format: 'md' | 'html' | 'pdf' | 'docx' | 'txt' | 'png' | 'jpg'
    title?: string
    markdown?: string
    html?: string
  }) => ipcRenderer.invoke('render-export', payload)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', {
      ...electronAPI,
      ipcRenderer: {
        on: (channel: string, listener: (event: any, ...args: any[]) => void) => {
          ipcRenderer.on(channel, listener)
        },
        send: (channel: string, ...args: any[]) => {
          ipcRenderer.send(channel, ...args)
        },
        removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => {
          ipcRenderer.removeListener(channel, listener)
        },
        removeAllListeners: (channel: string) => {
          ipcRenderer.removeAllListeners(channel)
        }
      }
    })
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = {
    ...electronAPI,
    ipcRenderer: {
      on: (channel: string, listener: (event: any, ...args: any[]) => void) => {
        ipcRenderer.on(channel, listener)
      },
      send: (channel: string, ...args: any[]) => {
        ipcRenderer.send(channel, ...args)
      },
      removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => {
        ipcRenderer.removeListener(channel, listener)
      },
      removeAllListeners: (channel: string) => {
        ipcRenderer.removeAllListeners(channel)
      }
    }
  }
  // @ts-ignore (define in dts)
  window.api = api
}
