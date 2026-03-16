import { ElectronAPI } from '@electron-toolkit/preload'

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

export type LLMProviderProfileView = {
  id: string
  label: string
  providerType: 'openai_compatible'
  baseUrl: string
  model: string
  endpointMode: LLMEndpointMode
  hasApiKey: boolean
}

export type EffectiveLLMSettingsView = {
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
}

export type LLMConnectionTestResult = {
  ok: boolean
  statusCode: number | null
  latencyMs: number
  endpointMode: Exclude<LLMEndpointMode, 'auto'>
  requestUrl: string
  model: string
  preview: string
  error?: string
}

declare global {
  interface Window {
    electron: ElectronAPI & {
      ipcRenderer: {
        on: (channel: string, listener: (event: any, ...args: any[]) => void) => void
        send: (channel: string, ...args: any[]) => void
        removeListener: (channel: string, listener: (event: any, ...args: any[]) => void) => void
        removeAllListeners: (channel: string) => void
      }
    }
    api: {
      navigate: (url: string) => void
      resizeView: (bounds: { width: number; height: number }) => void
      // 新增标签页相关 API
      tabSelect: (id: number) => void
      tabClose: (id: number) => void
      tabNew: (url?: string) => void
      setTheme: (color: string) => void
      // 设置模式
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
        profiles: LLMProviderProfileView[]
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
        profiles: LLMProviderProfileView[]
      }>
      getEffectiveLLMSettings: (options?: { includeApiKey?: boolean }) => Promise<EffectiveLLMSettingsView>
      testLLMSettings: (input?: {
        profileId?: string | null
        baseUrl?: string
        model?: string
        endpointMode?: LLMEndpointMode
        apiKey?: string
      }) => Promise<LLMConnectionTestResult>
      // 新增导航控制
      goBack: () => void
      goForward: () => void
      reload: () => void
      stop: () => void
      // 获取 Brain WebSocket URL
      getBrainUrl: () => Promise<string>
      // 渲染页导出
      renderExport: (payload: {
        format: 'md' | 'html' | 'pdf' | 'docx' | 'txt' | 'png' | 'jpg'
        title?: string
        markdown?: string
        html?: string
      }) => Promise<any>
    }
  }
}
