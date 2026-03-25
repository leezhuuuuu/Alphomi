// 定义 Tab 类型
export interface Tab {
  id: number
  title: string
  url: string      // 新增：当前 URL
  favicon?: string
  active: boolean
  isLoading: boolean // 新增：是否加载中
  canGoBack: boolean // 新增：能否后退
  canGoForward: boolean // 新增：能否前进
  isPinned: boolean
}

export interface NavigationState {
  url: string
  title?: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  favicon?: string
}

export type LLMEndpointMode = 'auto' | 'chat_completions' | 'responses'

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

export type TeachingTimelineItemRecord = {
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

export type TeachingArtifactRecord = {
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
  status: 'idle' | 'recording' | 'processing' | 'review' | 'stopped' | 'interrupted' | 'saved'
  lockedTabId: number
  lockedTabTitle?: string
  lockedTabUrl?: string
  createdAt: string
  updatedAt: string
  startedAt: string
  stoppedAt?: string | null
  notes: string[]
  timeline: TeachingTimelineItemRecord[]
  artifacts: TeachingArtifactRecord[]
}

export type TeachingStateSnapshot = {
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

export type TeachingEventPayload = {
  type: string
  sessionId?: string | null
  createdAt?: string
  item?: TeachingTimelineItemRecord
  artifact?: TeachingArtifactRecord
  message?: string
  error?: string
  [key: string]: unknown
}

// 扩展 Window 接口
declare global {
  interface ImportMetaEnv {
    readonly VITE_THEME_MODE?: string
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }

  interface Window {
    electron: {
      ipcRenderer: {
        on: (channel: string, listener: (event: any, ...args: any[]) => void) => void
        send: (channel: string, ...args: any[]) => void
        removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => void
        removeAllListeners: (channel: string) => void
      }
    }
    api: {
      navigate: (url: string) => void
      resizeView: (bounds: { x: number; y: number; width: number; height: number }) => void
      tabSelect: (id: number) => void
      tabClose: (id: number) => void
      tabNew: (url?: string) => void
      setTheme: (color: string) => void
      setMode: (mode: 'light' | 'dark' | 'system') => void
      getSettings: () => Promise<{
        themeMode: 'light' | 'dark' | 'system'
        newTabUrl: string
        toolStates: Record<string, boolean>
      }>
      updateSettings: (patch: {
        themeMode?: 'light' | 'dark' | 'system'
        newTabUrl?: string
        toolStates?: Record<string, boolean>
      }) => Promise<{
        themeMode: 'light' | 'dark' | 'system'
        newTabUrl: string
        toolStates: Record<string, boolean>
      }>
      getToolCatalog: () => Promise<
        {
          id: string
          title: string
          description: string
          tools: {
            name: string
            label: string
            description: string
            scope: 'browser' | 'brain'
          }[]
        }[]
      >
      getLLMSettings: () => Promise<{
        activeProfileId: string | null
        profiles: {
          id: string
          label: string
          providerType: 'openai_compatible'
          baseUrl: string
          model: string
          endpointMode: LLMEndpointMode
          hasApiKey: boolean
        }[]
      }>
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
      }) => Promise<{
        activeProfileId: string | null
        profiles: {
          id: string
          label: string
          providerType: 'openai_compatible'
          baseUrl: string
          model: string
          endpointMode: LLMEndpointMode
          hasApiKey: boolean
        }[]
      }>
      getEffectiveLLMSettings: (options?: { includeApiKey?: boolean }) => Promise<{
        providerType: 'openai_compatible'
        activeProfileId: string | null
        activeProfileLabel: string | null
        baseUrl: string
        model: string
        endpointMode: LLMEndpointMode
        apiKey: string
        hasApiKey: boolean
        sources: {
          baseUrl: 'environment' | 'user' | 'config' | 'default' | 'unset'
          model: 'environment' | 'user' | 'config' | 'default' | 'unset'
          endpointMode: 'environment' | 'user' | 'config' | 'default' | 'unset'
          apiKey: 'environment' | 'user' | 'config' | 'default' | 'unset'
        }
      }>
      testLLMSettings: (input?: {
        profileId?: string | null
        baseUrl?: string
        model?: string
        endpointMode?: LLMEndpointMode
        apiKey?: string
      }) => Promise<{
        ok: boolean
        statusCode: number | null
        latencyMs: number
        endpointMode: Exclude<LLMEndpointMode, 'auto'>
        requestUrl: string
        model: string
        preview: string
        error?: string
      }>
      openMenu: (anchor: { x: number; y: number; width: number; height: number }) => void
      menuAction: (action: string) => Promise<{ zoomPercent?: number; closeMenu?: boolean }>
      getMenuState: () => Promise<{ zoomPercent: number; mode: 'light' | 'dark' }>
      // 新增导航控制
      goBack: () => void
      goForward: () => void
      reload: () => void
      stop: () => void
      // 获取 Brain WebSocket URL
      getBrainUrl: () => Promise<string>
      teachingStart: () => Promise<TeachingStateSnapshot>
      teachingStop: () => Promise<TeachingStateSnapshot>
      teachingAddNote: (payload: string | { text: string }) => Promise<TeachingStateSnapshot>
      teachingGetState: () => Promise<TeachingStateSnapshot>
      onTeachingEvent: (listener: (payload: TeachingEventPayload) => void) => () => void
      onTeachingState: (listener: (payload: TeachingStateSnapshot) => void) => () => void
      onTeachingError: (listener: (payload: { message: string; error?: string }) => void) => () => void
      getDownloads: () => Promise<{
        id: string
        url: string
        filename: string
        receivedBytes: number
        totalBytes: number
        state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
        savePath?: string
        startedAt: number
      }[]>
      downloadAction: (action: 'show' | 'open' | 'cancel', id: string) => Promise<{ ok: boolean }>
    }
  }
}

export {}
