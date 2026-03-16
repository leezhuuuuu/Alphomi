import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 定义 Tab 类型
interface Tab {
  id: number
  title: string
  active: boolean
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
  updateSettings: (patch: { themeMode?: 'light' | 'dark' | 'system'; newTabUrl?: string }) =>
    ipcRenderer.invoke('settings-update', patch),
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
