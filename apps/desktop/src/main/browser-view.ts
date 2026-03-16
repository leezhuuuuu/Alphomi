import { app, BrowserWindow, WebContentsView, ipcMain, Menu, dialog, clipboard, shell, nativeTheme } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import axios from 'axios'
import { DRIVER_PORT } from './process-manager'
import htmlDocx from 'html-docx-js'
import { loadUserDataConfig } from './user-data-config'
import { loadAppSettings } from './app-settings'

// 1. 定义注入的 CSS 内容（注意转义引号）
const SCROLLBAR_STYLE_ID = 'alphomi-scrollbar-style'
const RENDER_PAGE_PREFIX = `http://127.0.0.1:${DRIVER_PORT}/render/md/`
const RENDER_DISPLAY_PREFIX = 'report://markdown/'
const TAB_ID_WINDOW_PROPERTY = '__AI_BROWSER_TAB_ID'
const RUNTIME_PARTITION = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const CHROME_USER_AGENT = (() => {
  const fallback = app.userAgentFallback || ''
  const stripped = fallback.replace(/\sElectron\/\S+/g, '').trim()
  return stripped || fallback
})()

function resolveBrowserPartition() {
  const config = loadUserDataConfig()
  if (config.enabled && config.mode === 'browser-profile') {
    return `persist:${config.profileId}`
  }
  return RUNTIME_PARTITION
}
const DARK_SCROLLBAR_CSS = `
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: #202124; }
  ::-webkit-scrollbar-thumb { background: #5f6368; border-radius: 5px; border: 2px solid #202124; }
  ::-webkit-scrollbar-thumb:hover { background: #80868b; }
`

// 扩展内部 Tab 接口
interface TabState {
  id: number
  view: WebContentsView
  title: string
  url: string
  favicon: string
  isLoading: boolean
  isSettings: boolean
  hasInjectedTabId: boolean
  isPinned: boolean
  // 🟢 移除 darkModeCssKey，不再需要它了
}

type DevToolsMode = 'detach' | 'bottom' | 'right'

interface DownloadEntry {
  id: string
  url: string
  filename: string
  receivedBytes: number
  totalBytes: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  savePath?: string
  startedAt: number
}

type RenderPageData = {
  title?: string
  markdown?: string
  html?: string
  exportHtml?: string
}

type UserDataActivity = {
  reason: string
  url?: string
}

const userDataActivityHandlers = new Set<(activity: UserDataActivity) => void>()

export function registerUserDataActivityHandler(handler: (activity: UserDataActivity) => void) {
  userDataActivityHandlers.add(handler)
  return () => {
    userDataActivityHandlers.delete(handler)
  }
}

function emitUserDataActivity(reason: string, url?: string) {
  const payload = { reason, url }
  userDataActivityHandlers.forEach(handler => {
    try {
      handler(payload)
    } catch (e) {
      // ignore handler errors
    }
  })
}

let mainWindow: BrowserWindow | null = null
let tabs: TabState[] = []
let activeTabId: number | null = null
let nextTabId = 1
let currentSessionId: string | null = null
let currentMode: 'light' | 'dark' | 'system' = 'light' // 全局记录模式
let lastDevToolsMode: DevToolsMode = 'detach'
let nextDownloadId = 1
const downloads = new Map<string, DownloadEntry>()
const downloadItems = new Map<string, Electron.DownloadItem>()
const downloadSessions = new WeakSet<Electron.Session>()
const pendingSavePaths: Array<{ url: string; savePath: string }> = []

const SETTINGS_TAB_URL = 'app://settings'
let lastLayoutBounds: { x: number, y: number, width: number, height: number } | null = null

const SIDEBAR_WIDTH = 350
const TOP_UI_HEIGHT = 36 + 44

const SETTINGS_PAGE_PATH = join(__dirname, '../renderer/settings.html')
const DEVTOOLS_PREF_PATH = join(app.getPath('userData'), 'devtools-preferences.json')
const INTERNAL_TAB_FAVICON =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#0f766e"/>
          <stop offset="100%" stop-color="#34b3a0"/>
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="16" fill="url(#g)"/>
      <path d="M22 20h8l12 24h-8l-2-4h-10l-2 4h-8l10-24zm5 14h4l-2-5-2 5z" fill="#f7f9fb"/>
    </svg>`
  )

function isSettingsUrl(url?: string) {
  return url === SETTINGS_TAB_URL
}

function getDefaultNewTabUrl() {
  return loadAppSettings().newTabUrl
}

function loadSettingsPage(tab: TabState) {
  tab.isSettings = true
  tab.url = SETTINGS_TAB_URL
  tab.title = 'Settings'
  tab.favicon = INTERNAL_TAB_FAVICON
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    tab.view.webContents.loadURL(new URL('settings.html', devUrl).toString())
  } else {
    tab.view.webContents.loadFile(SETTINGS_PAGE_PATH)
  }
  broadcastState()
}

function shouldUseInternalTabIcon(tab: TabState) {
  return tab.isSettings || tab.url.startsWith(RENDER_PAGE_PREFIX)
}

function normalizeFaviconCandidate(pageUrl: string, candidate?: string | null): string {
  const raw = String(candidate ?? '').trim()
  if (!raw) return ''

  if (
    raw.startsWith('data:') ||
    raw.startsWith('blob:') ||
    raw.startsWith('http://') ||
    raw.startsWith('https://') ||
    raw.startsWith('file://')
  ) {
    return raw
  }

  try {
    if (raw.startsWith('//')) {
      const page = new URL(pageUrl)
      return `${page.protocol}${raw}`
    }
    return new URL(raw, pageUrl).toString()
  } catch {
    return ''
  }
}

function buildOriginFaviconUrl(pageUrl: string): string {
  try {
    const url = new URL(pageUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return new URL('/favicon.ico', url.origin).toString()
  } catch {
    return ''
  }
}

function setTabFavicon(tab: TabState, favicon: string) {
  if (tab.favicon === favicon) return
  tab.favicon = favicon
  broadcastState()
}

async function extractPageFaviconCandidates(tab: TabState): Promise<string[]> {
  const wc = tab.view.webContents
  if (wc.isDestroyed()) return []

  try {
    const result = await wc.executeJavaScript(
      `(() => {
        const links = Array.from(document.querySelectorAll('link[rel]'));
        return links
          .filter((link) => /(^|\\s)(icon|apple-touch-icon|mask-icon)(\\s|$)/i.test(link.rel || ''))
          .map((link) => link.href || link.getAttribute('href') || '')
          .filter(Boolean);
      })()`,
      true
    )
    return Array.isArray(result) ? result.map((item) => String(item || '')).filter(Boolean) : []
  } catch {
    return []
  }
}

async function refreshTabFavicon(tab: TabState) {
  if (shouldUseInternalTabIcon(tab)) {
    setTabFavicon(tab, INTERNAL_TAB_FAVICON)
    return
  }

  const wc = tab.view.webContents
  if (wc.isDestroyed()) return

  const currentUrl = wc.getURL() || tab.url
  if (!currentUrl || currentUrl.startsWith('about:')) {
    setTabFavicon(tab, '')
    return
  }

  const currentDisplayedUrl = tab.url
  const domCandidates = await extractPageFaviconCandidates(tab)
  const normalized = domCandidates
    .map((candidate) => normalizeFaviconCandidate(currentUrl, candidate))
    .filter(Boolean)

  const fallback = buildOriginFaviconUrl(currentUrl)
  const nextFavicon = normalized[0] || fallback

  if (tab.url !== currentDisplayedUrl) return
  setTabFavicon(tab, nextFavicon)
}

function loadDevToolsMode(): DevToolsMode {
  try {
    if (!existsSync(DEVTOOLS_PREF_PATH)) return 'detach'
    const raw = readFileSync(DEVTOOLS_PREF_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed?.mode === 'bottom' || parsed?.mode === 'right' || parsed?.mode === 'detach') {
      return parsed.mode
    }
  } catch (e) {
    return 'detach'
  }
  return 'detach'
}

function persistDevToolsMode(mode: DevToolsMode) {
  try {
    writeFileSync(DEVTOOLS_PREF_PATH, JSON.stringify({ mode }), 'utf-8')
  } catch (e) {}
}

function setDevToolsMode(mode: DevToolsMode, wc?: Electron.WebContents) {
  lastDevToolsMode = mode
  persistDevToolsMode(mode)
  if (wc && !wc.isDestroyed()) {
    wc.openDevTools({ mode })
  }
}

function isViewAlive(view?: WebContentsView | null) {
  const wc = view?.webContents
  return Boolean(wc && !wc.isDestroyed())
}

function getWindowContentView(window: BrowserWindow) {
  return (window as BrowserWindow & { contentView: Electron.View }).contentView
}

export function setupBrowserViews(window: BrowserWindow) {
  mainWindow = window
  lastDevToolsMode = loadDevToolsMode()
  createTab(getDefaultNewTabUrl())

  // --- IPC 监听 ---
  ipcMain.on('resize-view', (_, bounds) => updateLayout(bounds))
  ipcMain.on('navigate', (_, url) => {
    const tab = tabs.find(t => t.id === activeTabId)
    if (tab) {
      console.log(`[Main] Navigating to: ${url}`) // 添加日志
      if (isSettingsUrl(url)) {
        if (!tab.isSettings) {
          createTab(url)
          return
        }
        loadSettingsPage(tab)
        return
      }
      if (tab.isSettings) {
        createTab(url)
        return
      }
      tab.isSettings = false
      tab.view.webContents.loadURL(url)
    }
  })

  ipcMain.on('tab-select', (_, id) => selectTab(id))
  ipcMain.on('tab-close', (_, id) => closeTab(id))
  ipcMain.on('tab-new', (_, url?: string) => {
    const targetUrl = typeof url === 'string' && url.length > 0 ? url : getDefaultNewTabUrl()
    createTab(targetUrl)
  })

  ipcMain.on('go-back', () => getActiveWebContents()?.goBack())
  ipcMain.on('go-forward', () => getActiveWebContents()?.goForward())
  ipcMain.on('reload', () => getActiveWebContents()?.reload())
  ipcMain.on('stop', () => getActiveWebContents()?.stop())

  window.webContents.setWindowOpenHandler(({ url }) => {
    createTab(url)
    return { action: 'deny' }
  })
}

export function getActiveWebContents() {
  const tab = tabs.find(t => t.id === activeTabId)
  return tab?.view.webContents
}

function createTab(url: string) {
  if (!mainWindow) return

  const isSettings = isSettingsUrl(url)
  const isRender = url.startsWith(RENDER_PAGE_PREFIX)
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: !isSettings,
      backgroundThrottling: false,
      partition: resolveBrowserPartition(),
      ...(isSettings || isRender ? { preload: join(__dirname, '../preload/index.js') } : {})
    }
  })

  const id = nextTabId++
  const tab: TabState = {
    id,
    view,
    title: 'New Tab',
    url: isSettings ? SETTINGS_TAB_URL : url,
    favicon: '',
    isLoading: false,
    isSettings,
    hasInjectedTabId: false,
    isPinned: false
  }
  tabs.push(tab)

  const wc = view.webContents
  wc.setUserAgent(CHROME_USER_AGENT)

  wc.on('context-menu', async (_event: Electron.Event, params: Electron.ContextMenuParams) => {
    if (!mainWindow) return
    const menu = buildContextMenu(tab, params)
    menu.popup({ window: mainWindow })
  })

  registerDownloadListeners(wc)

  // 1. 标题更新
  wc.on('page-title-updated', (_event: Electron.Event, title: string) => {
    tab.title = title
    broadcastState()
  })

  // 2. 导航状态
  wc.on('did-start-loading', () => {
    tab.isLoading = true
    tab.favicon = shouldUseInternalTabIcon(tab) ? INTERNAL_TAB_FAVICON : ''
    applyPreferredColorScheme(tab, currentMode).catch(() => {})
    broadcastState()
  })

  wc.on('did-stop-loading', () => {
    tab.isLoading = false
    broadcastState()
    emitUserDataActivity('load', tab.url)
    void refreshTabFavicon(tab)
  })

  wc.on('did-navigate', (_event: Electron.Event, newUrl: string) => {
    tab.url = tab.isSettings ? SETTINGS_TAB_URL : newUrl
    broadcastState()
    emitUserDataActivity('navigate', tab.url)
    void refreshTabFavicon(tab)
  })

  wc.on('did-navigate-in-page', (_event: Electron.Event, newUrl: string) => {
    tab.url = tab.isSettings ? SETTINGS_TAB_URL : newUrl
    broadcastState()
    emitUserDataActivity('navigate-in-page', tab.url)
    void refreshTabFavicon(tab)
  })

  wc.on('page-favicon-updated', (_event: Electron.Event, favicons: string[]) => {
    if (!Array.isArray(favicons) || favicons.length === 0) return
    const normalized = favicons
      .map((candidate) => normalizeFaviconCandidate(wc.getURL() || tab.url, candidate))
      .filter(Boolean)
    if (normalized.length > 0) {
      setTabFavicon(tab, normalized[0] || '')
      return
    }
    void refreshTabFavicon(tab)
  })

  wc.on('focus', () => {
    if (!mainWindow || tab.id !== activeTabId) return
    mainWindow.webContents.send('content-focus')
  })

  wc.setWindowOpenHandler(({ url }: { url: string }) => {
    createTab(url)
    return { action: 'deny' }
  })

  // 🟢 关键：监听页面加载完成，注入样式
  // dom-ready 意味着页面 DOM 结构已生成，此时注入 <style> 最合适
  wc.on('dom-ready', async () => {
    await applyThemeToTab(tab)
    const injected = await setTabIdOnPage(tab)
    await refreshTabFavicon(tab)
    if (injected && tab.id === activeTabId && currentSessionId) {
      notifyDriverReattach().catch(console.error)
    }
  })

  // 🔴 关键修改：创建时先不要 addBrowserView，
  // 而是加载 URL 后，让 selectTab 统一负责"挂载"视图。
  // 这样避免 create 时的 add 和 select 时的操作冲突。
  if (isSettings) {
    loadSettingsPage(tab)
  } else if (url) {
    wc.loadURL(url)
  }

  selectTab(id)
}

function selectTab(id: number) {
  if (!mainWindow) return

  let targetId = id
  const targetTab = tabs.find(t => t.id === targetId)
  if (!targetTab || !isViewAlive(targetTab.view)) {
    const fallback = tabs.find(t => isViewAlive(t.view))
    if (!fallback) {
      activeTabId = null
      broadcastState()
      return
    }
    targetId = fallback.id
  }
  activeTabId = targetId
  const activeTab = tabs.find(t => t.id === targetId)
  emitUserDataActivity('tab-select', activeTab?.url)

  const fallbackBounds = (() => {
    const [width, height] = mainWindow!.getSize()
    // 确保计算出的宽度不为负数
    const viewWidth = Math.max(0, width - SIDEBAR_WIDTH)
    const viewHeight = Math.max(0, height - TOP_UI_HEIGHT)
    return { x: 0, y: TOP_UI_HEIGHT, width: viewWidth, height: viewHeight }
  })()
  const bounds = lastLayoutBounds || fallbackBounds

  // 🔴 关键修改：显式移除所有非活跃视图，添加活跃视图
  // WebContentsView 使用 contentView.addChildView/removeChildView
  tabs.forEach(t => {
    if (!isViewAlive(t.view)) return
    if (t.id === targetId) {
      // 1. 挂载：使用 contentView.addChildView
      // 注意：addChildView 会自动将视图置于顶层，所以不需要 setTopBrowserView
      try {
        getWindowContentView(mainWindow!).addChildView(t.view)
        // 2. 布局：设置尺寸
        t.view.setBounds(bounds)
      } catch (e) {
        console.error(`[selectTab] Failed to attach view for tab ${t.id}:`, e)
      }
      // 3. 删除旧 API 调用：t.view.setAutoResize(...) —— WebContentsView 不支持也不需要
    } else {
      // 4. 卸载：使用 contentView.removeChildView
      // 必须加 try-catch，因为如果 view 之前没被挂载(例如刚创建的后台标签)，removeChildView 会抛错
      try {
        getWindowContentView(mainWindow!).removeChildView(t.view)
      } catch (e) {
        // 忽略 "View is not a child of this View" 错误
      }
    }
  })

  // 通知 Driver
  if (currentSessionId) {
    const activeTab = tabs.find(t => t.id === activeTabId)
    if (activeTab?.hasInjectedTabId) {
      notifyDriverReattach().catch(console.error)
    }
  }

  broadcastState()
}

function reorderTabs() {
  const pinned = tabs.filter(tab => tab.isPinned)
  const normal = tabs.filter(tab => !tab.isPinned)
  tabs = [...pinned, ...normal]
}

function togglePinTab(tab: TabState) {
  tab.isPinned = !tab.isPinned
  reorderTabs()
  broadcastState()
}

function duplicateTab(tab: TabState) {
  createTab(tab.url)
}

function openUrlInNewWindow(url: string, options?: { incognito?: boolean }) {
  const partition = options?.incognito ? `incognito-${Date.now()}` : resolveBrowserPartition()
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      sandbox: true,
      partition
    }
  })
  win.webContents.setUserAgent(CHROME_USER_AGENT)
  registerDownloadListeners(win.webContents)
  win.loadURL(url)
}

export function openIncognitoWindow() {
  openUrlInNewWindow(getDefaultNewTabUrl(), { incognito: true })
}

function registerDownloadListeners(wc: Electron.WebContents) {
  const session = wc.session
  if (downloadSessions.has(session)) return
  downloadSessions.add(session)

  wc.session.on('will-download', (_, item) => {
    const downloadId = String(nextDownloadId++)
    const url = item.getURL()
    const entry: DownloadEntry = {
      id: downloadId,
      url,
      filename: item.getFilename(),
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      state: 'progressing',
      savePath: item.getSavePath(),
      startedAt: Date.now()
    }

    const pendingIndex = pendingSavePaths.findIndex(pending => pending.url === url)
    if (pendingIndex >= 0) {
      const pending = pendingSavePaths.splice(pendingIndex, 1)[0]
      item.setSavePath(pending.savePath)
      entry.savePath = pending.savePath
    }

    downloads.set(downloadId, entry)
    downloadItems.set(downloadId, item)
    notifyDownloadsUpdated()

    item.on('updated', () => {
      const current = downloads.get(downloadId)
      if (!current) return
      current.receivedBytes = item.getReceivedBytes()
      current.totalBytes = item.getTotalBytes()
      current.savePath = item.getSavePath() || current.savePath
      notifyDownloadsUpdated()
    })

    item.once('done', (_, state) => {
      const current = downloads.get(downloadId)
      if (!current) return
      current.receivedBytes = item.getReceivedBytes()
      current.totalBytes = item.getTotalBytes()
      current.savePath = item.getSavePath() || current.savePath
      current.state = state as DownloadEntry['state']
      notifyDownloadsUpdated()
    })
  })
}

function queueDownloadSavePath(url: string, savePath: string) {
  pendingSavePaths.push({ url, savePath })
}

function notifyDownloadsUpdated() {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('downloads-updated')
  })
}

export function getDownloads() {
  return Array.from(downloads.values()).sort((a, b) => b.startedAt - a.startedAt)
}

export function downloadAction(action: 'show' | 'open' | 'cancel', id: string) {
  const item = downloadItems.get(id)
  const entry = downloads.get(id)
  if (!item || !entry) return { ok: false }

  if (action === 'cancel') {
    item.cancel()
    return { ok: true }
  }
  if (!entry.savePath) return { ok: false }

  if (action === 'open') {
    shell.openPath(entry.savePath)
    return { ok: true }
  }
  if (action === 'show') {
    shell.showItemInFolder(entry.savePath)
    return { ok: true }
  }
  return { ok: false }
}

function buildContextMenu(tab: TabState, params: Electron.ContextMenuParams) {
  const wc = tab.view.webContents
  const template: Electron.MenuItemConstructorOptions[] = []
  const history = wc.navigationHistory

  const selectionText = (params.selectionText || '').trim()
  const hasSelection = selectionText.length > 0
  const hasLink = Boolean(params.linkURL)
  const hasSrc = Boolean(params.srcURL)
  const isEditable = params.isEditable
  const isImage = params.mediaType === 'image' && hasSrc
  const isMedia = (params.mediaType === 'video' || params.mediaType === 'audio') && hasSrc
  const currentUrl = wc.getURL()
  const isRenderPage = currentUrl.startsWith(RENDER_PAGE_PREFIX)

  template.push(
    {
      label: '后退',
      enabled: history.canGoBack(),
      click: () => wc.goBack()
    },
    {
      label: '前进',
      enabled: history.canGoForward(),
      click: () => wc.goForward()
    },
    { type: 'separator' },
    {
      label: '重新加载',
      click: () => wc.reload()
    },
    {
      label: '停止加载',
      enabled: tab.isLoading,
      click: () => wc.stop()
    }
  )

  if (hasLink) {
    template.push(
      { type: 'separator' },
      {
        label: '在新标签页打开链接',
        click: () => createTab(params.linkURL)
      },
      {
        label: '在新窗口打开链接',
        click: () => openUrlInNewWindow(params.linkURL)
      },
      {
        label: '在无痕窗口打开链接',
        click: () => openUrlInNewWindow(params.linkURL, { incognito: true })
      },
      {
        label: '复制链接地址',
        click: () => clipboard.writeText(params.linkURL)
      },
      {
        label: '在默认浏览器打开链接',
        click: () => shell.openExternal(params.linkURL)
      }
    )
  }

  if (isImage) {
    template.push(
      { type: 'separator' },
      {
        label: '在新标签页打开图片',
        click: () => createTab(params.srcURL)
      },
      {
        label: '复制图片地址',
        click: () => clipboard.writeText(params.srcURL)
      },
      {
        label: '复制图片',
        click: () => wc.copyImageAt(params.x, params.y)
      },
      {
        label: '保存图片为...',
        click: async () => {
          if (!mainWindow) return
          const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
            title: '保存图片为',
            defaultPath: params.suggestedFilename || 'image'
          })
          if (!canceled && filePath) {
            queueDownloadSavePath(params.srcURL, filePath)
            wc.downloadURL(params.srcURL)
          }
        }
      }
    )
  }

  if (isMedia) {
    template.push(
      { type: 'separator' },
      {
        label: '复制媒体地址',
        click: () => clipboard.writeText(params.srcURL)
      },
      {
        label: '保存媒体为...',
        click: async () => {
          if (!mainWindow) return
          const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
            title: '保存媒体为',
            defaultPath: params.suggestedFilename || 'media'
          })
          if (!canceled && filePath) {
            queueDownloadSavePath(params.srcURL, filePath)
            wc.downloadURL(params.srcURL)
          }
        }
      }
    )
  }

  if (hasSelection) {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(selectionText)}`
    template.push(
      { type: 'separator' },
      {
        label: '复制',
        role: 'copy'
      },
      {
        label: '在新标签页搜索',
        click: () => createTab(searchUrl)
      }
    )
  }

  if (isRenderPage) {
    template.push(
      { type: 'separator' },
      { label: '导出为 Markdown', click: () => exportRenderPage(wc, 'md') },
      { label: '导出为 HTML', click: () => exportRenderPage(wc, 'html') },
      { label: '导出为 PDF', click: () => exportRenderPage(wc, 'pdf') },
      { label: '导出为 DOCX', click: () => exportRenderPage(wc, 'docx') },
      { label: '导出为 TXT', click: () => exportRenderPage(wc, 'txt') },
      { label: '导出为 PNG', click: () => exportRenderPage(wc, 'png') },
      { label: '导出为 JPG', click: () => exportRenderPage(wc, 'jpg') }
    )
  }

  if (isEditable) {
    template.push(
      { type: 'separator' },
      { label: '撤销', role: 'undo' },
      { label: '重做', role: 'redo' },
      { type: 'separator' },
      { label: '剪切', role: 'cut' },
      { label: '复制', role: 'copy' },
      { label: '粘贴', role: 'paste' },
      { label: '全选', role: 'selectAll' }
    )
  }

  template.push(
    { type: 'separator' },
    {
      label: '复制页面地址',
      click: () => clipboard.writeText(currentUrl)
    },
    {
      label: '在默认浏览器打开页面',
      click: () => shell.openExternal(currentUrl)
    },
    {
      label: '在新窗口打开标签页',
      click: () => openUrlInNewWindow(currentUrl)
    },
    {
      label: '在无痕窗口打开标签页',
      click: () => openUrlInNewWindow(currentUrl, { incognito: true })
    },
    {
      label: tab.isPinned ? '取消固定标签页' : '固定标签页',
      click: () => togglePinTab(tab)
    },
    {
      label: '复制标签页',
      click: () => duplicateTab(tab)
    },
    {
      label: '查看页面源代码',
      click: () => createTab(`view-source:${currentUrl}`)
    },
    {
      label: '保存页面为...',
      click: async () => {
        if (!mainWindow) return
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
          title: '保存页面为',
          defaultPath: 'page.html'
        })
        if (!canceled && filePath) {
          try {
            await wc.savePage(filePath, 'HTMLComplete')
          } catch (error) {
            await dialog.showMessageBox(mainWindow, {
              type: 'error',
              title: '保存失败',
              message: '页面保存失败，请检查权限或磁盘空间。',
              detail: String(error)
            })
          }
        }
      }
    },
    {
      label: '打印...',
      click: () => wc.print({})
    },
    { type: 'separator' },
    {
      label: '检查元素',
      click: () => {
        if (!wc.isDevToolsOpened()) {
          wc.openDevTools({ mode: lastDevToolsMode })
        }
        wc.inspectElement(params.x, params.y)
        wc.devToolsWebContents?.focus()
      }
    },
    {
      label: '开发者工具',
      submenu: [
        {
          label: '在新窗口打开',
          type: 'radio',
          checked: lastDevToolsMode === 'detach',
          click: () => setDevToolsMode('detach', wc)
        },
        {
          label: '在底部打开',
          type: 'radio',
          checked: lastDevToolsMode === 'bottom',
          click: () => setDevToolsMode('bottom', wc)
        },
        {
          label: '在右侧打开',
          type: 'radio',
          checked: lastDevToolsMode === 'right',
          click: () => setDevToolsMode('right', wc)
        },
        { type: 'separator' },
        {
          label: '切换 DevTools',
          click: () => {
            if (wc.isDevToolsOpened()) {
              wc.closeDevTools()
            } else {
              wc.openDevTools({ mode: lastDevToolsMode })
            }
          }
        }
      ]
    }
  )

  return Menu.buildFromTemplate(template)
}

async function getRenderPageData(wc: Electron.WebContents): Promise<RenderPageData> {
  try {
    const data = await wc.executeJavaScript('window.__MD_RENDER__', true)
    if (data && typeof data === 'object') {
      return data as RenderPageData
    }
  } catch (e) {}
  return { title: 'Markdown Preview', markdown: '', html: '', exportHtml: '' }
}

function defaultExportPath(title: string, ext: string) {
  const safe = (title || 'document').replace(/[\\/:*?"<>|]+/g, '_')
  return `${safe}.${ext}`
}

async function exportRenderPage(
  wc: Electron.WebContents,
  format: 'md' | 'html' | 'pdf' | 'docx' | 'txt' | 'png' | 'jpg',
  payload?: { title?: string; markdown?: string; html?: string; exportHtml?: string }
) {
  if (!mainWindow) return
  const data = payload || (await getRenderPageData(wc))
  const ext = format === 'jpg' ? 'jpg' : format
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出文件',
    defaultPath: defaultExportPath(data.title || 'document', ext)
  })
  if (canceled || !filePath) return

  try {
    if (format === 'md') {
      writeFileSync(filePath, data.markdown || '', 'utf8')
      return
    }
    if (format === 'html') {
      const html = data.exportHtml || data.html || ''
      writeFileSync(filePath, html, 'utf8')
      return
    }
    if (format === 'txt') {
      const text = (data.markdown || '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/[#>*_~\-]/g, '')
      writeFileSync(filePath, text, 'utf8')
      return
    }
    if (format === 'pdf') {
      const pdf = await wc.printToPDF({})
      writeFileSync(filePath, pdf)
      return
    }
    if (format === 'png' || format === 'jpg') {
      const image = await wc.capturePage()
      const buffer = format === 'png' ? image.toPNG() : image.toJPEG(90)
      writeFileSync(filePath, buffer)
      return
    }
    if (format === 'docx') {
      const html = data.exportHtml || data.html || ''
      const docx = htmlDocx.asBlob(html) as any
      let buffer: Buffer
      if (Buffer.isBuffer(docx)) {
        buffer = docx
      } else if (docx && typeof docx.arrayBuffer === 'function') {
        buffer = Buffer.from(await docx.arrayBuffer())
      } else {
        buffer = Buffer.from(docx)
      }
      writeFileSync(filePath, buffer)
    }
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '导出失败',
      message: '导出失败，请检查权限或磁盘空间。',
      detail: String(error)
    })
  }
}

ipcMain.handle('render-export', async (event, payload) => {
  const wc = event.sender
  if (!wc || wc.isDestroyed()) return { ok: false }
  await exportRenderPage(wc, payload.format, payload)
  return { ok: true }
})

export function selectTabById(id: number) {
  const exists = tabs.some(t => t.id === id)
  if (!exists) return false
  selectTab(id)
  return true
}

export function selectTabByIndex(index: number) {
  if (index < 0 || index >= tabs.length) return false
  selectTab(tabs[index].id)
  return true
}

export function openTab(url?: string) {
  const targetUrl = typeof url === 'string' && url.length > 0 ? url : getDefaultNewTabUrl()
  createTab(targetUrl)
}

export function closeActiveTab() {
  if (typeof activeTabId === 'number') {
    closeTab(activeTabId)
  }
}

export function getActiveTabInfo() {
  const tab = tabs.find(t => t.id === activeTabId)
  if (!tab) return null
  return {
    id: tab.id,
    title: tab.title,
    url: tab.url
  }
}

function closeTab(id: number) {
  const index = tabs.findIndex(t => t.id === id)
  if (index === -1) return

  const tabToDelete = tabs[index]
  // 移除并销毁
  try {
    if (mainWindow) {
      getWindowContentView(mainWindow).removeChildView(tabToDelete.view)
    }
  } catch (e) {
    // 忽略未挂载错误
  }
  tabs.splice(index, 1)
  // 延迟销毁，避免同一事件循环里被 selectTab 再次引用
  setImmediate(() => {
    const wc = tabToDelete.view?.webContents
    if (!wc || wc.isDestroyed()) return
    try {
      // @ts-ignore
      wc.destroy()
    } catch (e) {}
  })

  if (tabs.length === 0) {
      createTab(getDefaultNewTabUrl())
  } else if (activeTabId === id) {
      selectTab(tabs[Math.max(0, index - 1)].id)
  } else {
      broadcastState()
  }
}

function broadcastState() {
  if (!mainWindow) return

  const tabsPayload = tabs.map(t => ({
    id: t.id,
    title: t.title,
    url: getDisplayUrl(t.url),
    favicon: t.favicon,
    active: t.id === activeTabId,
    isLoading: t.isLoading,
    isPinned: t.isPinned
  }))

  mainWindow.webContents.send('tabs-update', tabsPayload)

  const activeTab = tabs.find(t => t.id === activeTabId)
  if (activeTab) {
    const wc = activeTab.view.webContents
    if (wc.isDestroyed()) return
    const history = wc.navigationHistory
    const navState = {
      url: getDisplayUrl(activeTab.url),
      title: activeTab.title,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      isLoading: activeTab.isLoading,
      favicon: activeTab.favicon
    }
    mainWindow.webContents.send('active-tab-update', navState)
  }
}

function getDisplayUrl(rawUrl: string) {
  if (!rawUrl) return rawUrl
  if (!rawUrl.startsWith(RENDER_PAGE_PREFIX)) return rawUrl
  const id = rawUrl.slice(RENDER_PAGE_PREFIX.length).split(/[?#]/)[0]
  return `${RENDER_DISPLAY_PREFIX}${id || 'preview'}`
}

// 供外部调用
export function setSessionId(sessionId: string) {
  currentSessionId = sessionId
  console.log(`[BrowserView] Session ID set to: ${sessionId}`)
}

async function notifyDriverReattach() {
  if (!currentSessionId) return
  try {
    const payload: { sessionId: string; tabId?: number } = { sessionId: currentSessionId }
    if (typeof activeTabId === 'number') {
      payload.tabId = activeTabId
    }
    await axios.post(`http://localhost:${DRIVER_PORT}/sessions/reattach`, {
      ...payload
    })
    console.log(`[BrowserView] Notified Driver to reattach to session ${currentSessionId}`)
  } catch (error) {
    console.error('[BrowserView] Failed to notify Driver:', error)
  }
}

function updateLayout(bounds: { x?: number, y?: number, width: number, height: number }) {
    const tab = tabs.find(t => t.id === activeTabId)
    if (tab && isViewAlive(tab.view)) {
        const x = typeof (bounds as any).x === 'number' ? (bounds as any).x : 0
        const y = typeof (bounds as any).y === 'number' ? (bounds as any).y : TOP_UI_HEIGHT
        const width = Math.max(0, bounds.width)
        const height = Math.max(0, bounds.height)
        lastLayoutBounds = { x, y, width, height }
        tab.view.setBounds(lastLayoutBounds)
    }
}

async function applyPreferredColorScheme(tab: TabState, mode: 'light' | 'dark' | 'system') {
  const wc = tab.view.webContents
  if (wc.isDestroyed()) return

  const features = mode === 'system'
    ? []
    : [{ name: 'prefers-color-scheme', value: mode }]

  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3')
    }
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features })
  } catch (e) {
    // 忽略 debugger attach/command 失败
  }
}

// 🟢 核心修复：基于 DOM 的样式注入函数
async function applyThemeToTab(tab: TabState) {
  const wc = tab.view.webContents
  if (wc.isDestroyed()) return

  await applyPreferredColorScheme(tab, currentMode)

  const resolvedMode =
    currentMode === 'system'
      ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
      : currentMode

  if (resolvedMode === 'dark') {
    // 逻辑：如果是深色，注入 <style> 标签（如果已存在则不重复添加）
    const js = `
      (function() {
        if (!document.getElementById('${SCROLLBAR_STYLE_ID}')) {
          const style = document.createElement('style');
          style.id = '${SCROLLBAR_STYLE_ID}';
          style.innerHTML = \`${DARK_SCROLLBAR_CSS}\`;
          document.head.appendChild(style);
        }
      })();
    `
    try { await wc.executeJavaScript(js) } catch (e) {}
  } else {
    // 逻辑：如果是浅色，找到 <style> 标签并移除
    const js = `
      (function() {
        const style = document.getElementById('${SCROLLBAR_STYLE_ID}');
        if (style) style.remove();
      })();
    `
    try { await wc.executeJavaScript(js) } catch (e) {}
  }
}

async function setTabIdOnPage(tab: TabState): Promise<boolean> {
  const wc = tab.view.webContents
  if (wc.isDestroyed()) return false

  const js = `
    (function() {
      try {
        window['${TAB_ID_WINDOW_PROPERTY}'] = ${tab.id};
      } catch (e) {}
    })();
  `
  try {
    await wc.executeJavaScript(js)
    tab.hasInjectedTabId = true
    return true
  } catch (e) {
    return false
  }
}

export function setBrowserViewTheme(mode: 'light' | 'dark' | 'system') {
  currentMode = mode

  // 立即遍历所有 Tab 应用
  tabs.forEach(tab => {
    applyThemeToTab(tab)
  })
}
