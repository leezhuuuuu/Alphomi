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
