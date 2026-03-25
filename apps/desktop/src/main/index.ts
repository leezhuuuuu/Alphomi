import { app, shell, BrowserWindow, ipcMain, nativeTheme, Menu, dialog } from 'electron'
import http from 'http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import * as path from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  setupBrowserViews,
  setSessionId,
  selectTabById,
  selectTabByIndex,
  setBrowserViewTheme,
  getActiveTabInfo,
  getActiveWebContents,
  registerUserDataActivityHandler,
  openTab,
  closeActiveTab,
  openIncognitoWindow,
  getDownloads,
  downloadAction
} from './browser-view'
import { ProcessManager, DRIVER_PORT, BRAIN_PORT, DESKTOP_CONTROL_PORT } from './process-manager'
import axios from 'axios'
import { loadUserDataConfig, UserDataConfig } from './user-data-config'
import { buildStorageState, loadStorageState, saveStorageState } from './storage-state'
import { AppSettings, loadAppSettings, ThemeMode, updateAppSettings } from './app-settings'
import { getToolCatalogSections } from './tool-settings'
import {
  loadLLMSettings,
  resolveEffectiveLLMSettings,
  testLLMConnection,
  updateLLMSettings
} from './llm-settings'
import { initializeTeachingCapture } from './teaching-capture'

// 开启 CDP，使用高位端口避免冲突
const CDP_PORT = 19222
app.commandLine.appendSwitch('remote-debugging-port', CDP_PORT.toString())

// 配置代理绕过规则：本地流量直连，外网流量走代理
// <local> 代表所有不带点的本地地址 (如 localhost)
// 127.0.0.1 和 ::1 是本地回环
app.commandLine.appendSwitch('proxy-bypass-list', '<local>;127.0.0.1;::1;localhost')

// 保持这个，防止自签名证书报错
app.commandLine.appendSwitch('ignore-certificate-errors')

function setupDevTerminationGuards() {
  if (!is.dev) return

  let quitRequested = false
  const requestQuit = () => {
    if (quitRequested) return
    quitRequested = true

    if (app.isReady()) {
      app.quit()
    } else {
      app.once('ready', () => app.quit())
    }

    const forceTimer = setTimeout(() => {
      process.exit(0)
    }, 5000)
    forceTimer.unref()
  }

  const signalHandler = () => requestQuit()
  process.on('SIGINT', signalHandler)
  process.on('SIGTERM', signalHandler)
  process.on('SIGQUIT', signalHandler)
  process.on('SIGHUP', signalHandler)
  process.on('disconnect', signalHandler)

  const stdioHandler = (err?: NodeJS.ErrnoException | null) => {
    if (!err) return
    if (err.code === 'EPIPE' || err.code === 'EIO') {
      requestQuit()
    }
  }
  process.stdout?.on('error', stdioHandler)
  process.stderr?.on('error', stdioHandler)

  const parentPid = process.ppid
  if (parentPid && parentPid > 1) {
    const timer = setInterval(() => {
      if (process.ppid !== parentPid) {
        requestQuit()
      }
    }, 1000)
    timer.unref()
  }
}

setupDevTerminationGuards()

let controlServer: http.Server | null = null
let mainWindow: BrowserWindow | null = null
let menuWindow: BrowserWindow | null = null
let downloadsWindow: BrowserWindow | null = null
let currentUiMode: 'light' | 'dark' = 'light'
let userDataConfig: UserDataConfig | null = null
let driverBaseUrl: string | null = null
let activeSessionId: string | null = null
let saveTimer: NodeJS.Timeout | null = null
let eventSaveTimer: NodeJS.Timeout | null = null
let lastUserDataSaveAt = 0
let saveInFlight: Promise<void> | null = null
let isQuitting = false
let teachingCaptureController: ReturnType<typeof initializeTeachingCapture> | null = null

const MENU_WIDTH = 240
const MENU_HEIGHT = 420
const MENU_MARGIN = 8
const MENU_PAGE_PATH = path.join(__dirname, '../renderer/menu.html')
const DOWNLOADS_PAGE_PATH = path.join(__dirname, '../renderer/downloads.html')
const DEV_ICON_PATH = path.join(process.cwd(), 'apps/desktop/assets/icon.png')

type PortEntry = {
  port: number
  url: string
  ready?: boolean
  updatedAt: string
}

type PortRegistry = {
  driver?: PortEntry
  brain?: PortEntry
  desktopControl?: PortEntry
  cdp?: PortEntry
  sessionId?: string
}

let registryPath: string | null = null

function findWorkspaceRoot(startDir: string): string {
  let current = startDir
  while (true) {
    const hasPnpmWorkspace = existsSync(path.join(current, 'pnpm-workspace.yaml'))
    const hasTurbo = existsSync(path.join(current, 'turbo.json'))
    if (hasPnpmWorkspace || hasTurbo) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      return startDir
    }
    current = parent
  }
}

function resolveRegistryPath(): string {
  if (registryPath) return registryPath

  const fromEnv = process.env.PORT_REGISTRY_PATH
  if (fromEnv) {
    registryPath = fromEnv
    return registryPath
  }

  // 开发环境使用工作区 temp/，生产环境使用 userData
  if (is.dev) {
    const workspaceRoot = findWorkspaceRoot(process.cwd())
    registryPath = path.join(workspaceRoot, 'temp', 'ports.json')
  } else {
    registryPath = path.join(app.getPath('userData'), 'ports.json')
  }
  return registryPath
}

function readRegistry(): PortRegistry | null {
  const file = resolveRegistryPath()
  try {
    const raw = readFileSync(file, 'utf8')
    return JSON.parse(raw) as PortRegistry
  } catch {
    return null
  }
}

function writeRegistry(patch: Partial<PortRegistry>): PortRegistry {
  const file = resolveRegistryPath()
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })

  const current = readRegistry() ?? {}
  const next: PortRegistry = { ...current, ...patch }
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  return next
}

function registerInitialPorts() {
  const now = new Date().toISOString()
  writeRegistry({
    driver: {
      port: DRIVER_PORT,
      url: `http://127.0.0.1:${DRIVER_PORT}`,
      ready: false,
      updatedAt: now
    },
    brain: {
      port: BRAIN_PORT,
      url: `http://127.0.0.1:${BRAIN_PORT}`,
      ready: false,
      updatedAt: now
    },
    desktopControl: {
      port: DESKTOP_CONTROL_PORT,
      url: `http://127.0.0.1:${DESKTOP_CONTROL_PORT}`,
      ready: false,
      updatedAt: now
    },
    cdp: {
      port: CDP_PORT,
      url: `http://127.0.0.1:${CDP_PORT}`,
      updatedAt: now
    }
  })
  console.log('[Main] Port registry initialized at:', resolveRegistryPath())
}

function resolveInitialDriverUrl(): string {
  if (process.env.DRIVER_URL) {
    return process.env.DRIVER_URL
  }
  if (process.env.DRIVER_PORT) {
    return `http://127.0.0.1:${process.env.DRIVER_PORT}`
  }

  const reg = readRegistry()
  if (reg?.driver?.url) {
    return reg.driver.url
  }
  if (reg?.driver?.port) {
    return `http://127.0.0.1:${reg.driver.port}`
  }

  return `http://127.0.0.1:${DRIVER_PORT}`
}

function markRegistryReady(
  key: keyof PortRegistry,
  port: number,
  url: string,
  extra: Partial<PortEntry> = {}
) {
  const now = new Date().toISOString()
  writeRegistry({
    [key]: {
      port,
      url,
      ready: true,
      updatedAt: now,
      ...extra
    }
  } as Partial<PortRegistry>)
}

function resolveUserDataConfig(): UserDataConfig {
  if (!userDataConfig) {
    userDataConfig = loadUserDataConfig()
  }
  return userDataConfig
}

function broadcastToAllWindows(channel: string, payload: unknown) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, payload)
  })
}

async function restoreUserData(sessionId: string) {
  const config = resolveUserDataConfig()
  if (!config.enabled || config.mode !== 'cookies-only') return
  if (!driverBaseUrl) return

  const state = loadStorageState(config.storagePath, config.profileId)
  if (!state) return

  try {
    await axios.post(
      `${driverBaseUrl}/sessions/${sessionId}/storageState`,
      {
        cookies: state.cookies,
        localStorage: state.localStorage,
        mergePolicy: config.localStorageMerge
      },
      { timeout: 15000 }
    )
    console.log('[Main] User data restored from state file.')
  } catch (e) {
    console.warn('[Main] Failed to restore user data:', e)
  }
}

async function persistUserData(sessionId: string, reason: string) {
  const config = resolveUserDataConfig()
  if (!config.enabled || config.mode !== 'cookies-only') return
  if (!driverBaseUrl) return
  if (saveInFlight) return saveInFlight

  saveInFlight = (async () => {
    try {
      const response = await axios.get(`${driverBaseUrl}/sessions/${sessionId}/storageState`, {
        params: { scope: config.localStorageScope },
        timeout: 15000
      })

      if (!response.data?.success) {
        console.warn('[Main] StorageState export failed, keep old state.')
        return
      }

      const data = response.data.data || {}
      const state = buildStorageState({
        profileId: config.profileId,
        cookies: Array.isArray(data.cookies) ? data.cookies : [],
        localStorage: data.localStorage && typeof data.localStorage === 'object' ? data.localStorage : {},
        visitedOrigins: Array.isArray(data.visitedOrigins) ? data.visitedOrigins : []
      })

      saveStorageState(config.storagePath, state)
      lastUserDataSaveAt = Date.now()
      console.log(`[Main] User data saved (${reason}).`)
    } catch (e) {
      console.warn('[Main] Failed to persist user data:', e)
    }
  })()

  try {
    await saveInFlight
  } finally {
    saveInFlight = null
  }
}

function scheduleUserDataSave(reason: string) {
  const config = resolveUserDataConfig()
  if (!config.enabled || config.mode !== 'cookies-only') return
  if (!config.saveOnNavigation) return
  if (!activeSessionId) return

  const minIntervalMs = config.saveMinIntervalSec * 1000
  const now = Date.now()
  const sinceLast = now - lastUserDataSaveAt
  const delay = Math.max(config.saveDebounceMs, minIntervalMs - sinceLast, 0)

  if (eventSaveTimer) {
    clearTimeout(eventSaveTimer)
  }

  eventSaveTimer = setTimeout(() => {
    if (!activeSessionId) return
    persistUserData(activeSessionId, reason).catch(() => {})
  }, delay)
}

function startAutoSave(sessionId: string) {
  const config = resolveUserDataConfig()
  if (!config.enabled || config.mode !== 'cookies-only') return
  if (config.saveIntervalSec <= 0) return
  if (saveTimer) return

  saveTimer = setInterval(() => {
    persistUserData(sessionId, 'interval').catch(() => {})
  }, config.saveIntervalSec * 1000)
}

function stopAutoSave() {
  if (saveTimer) {
    clearInterval(saveTimer)
    saveTimer = null
  }
  if (eventSaveTimer) {
    clearTimeout(eventSaveTimer)
    eventSaveTimer = null
  }
}

async function probeDriver(baseUrl: string): Promise<boolean> {
  try {
    const health = await axios.get(`${baseUrl}/health`, { timeout: 600 })
    if (health.status !== 200) return false
  } catch {
    return false
  }

  try {
    // /tools 更能证明这是正确的 Driver
    const tools = await axios.get(`${baseUrl}/tools`, { timeout: 1200 })
    return Boolean(tools.data?.success)
  } catch (err: unknown) {
    // 只在 /tools 超时的情况下保守接受，其他错误继续扫描
    if (axios.isAxiosError(err) && err.code === 'ECONNABORTED') {
      return true
    }
    return false
  }
}

async function discoverDriverUrl(): Promise<string> {
  const candidates: string[] = []
  const seen = new Set<string>()
  const add = (url?: string | null) => {
    if (!url) return
    if (seen.has(url)) return
    seen.add(url)
    candidates.push(url)
  }

  // 1) 明确环境变量
  add(process.env.DRIVER_URL)
  if (process.env.DRIVER_PORT) {
    add(`http://127.0.0.1:${process.env.DRIVER_PORT}`)
  }

  // 2) 端口注册表
  const reg = readRegistry()
  if (reg?.driver?.url) add(reg.driver.url)
  if (reg?.driver?.port) add(`http://127.0.0.1:${reg.driver.port}`)

  // 3) 默认端口
  add(`http://127.0.0.1:${DRIVER_PORT}`)
  add(`http://localhost:${DRIVER_PORT}`)

  // 4) 恶劣端口环境：扫描一个小范围端口段
  for (let port = DRIVER_PORT; port <= DRIVER_PORT + 100; port += 1) {
    add(`http://127.0.0.1:${port}`)
  }

  for (const url of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await probeDriver(url)
    if (ok) {
      console.log('[Main] Discovered Driver at:', url)
      markRegistryReady('driver', Number(new URL(url).port), url)
      return url
    }
  }

  const fallback = `http://127.0.0.1:${DRIVER_PORT}`
  console.warn('[Main] Driver discovery failed, falling back to:', fallback)
  return fallback
}

async function probeBrain(baseUrl: string): Promise<boolean> {
  try {
    const health = await axios.get(`${baseUrl}/health`, { timeout: 600 })
    return health.status === 200
  } catch {
    return false
  }
}

function startBrainProbe() {
  const run = async () => {
    const reg = readRegistry()
    const candidates: string[] = []
    const seen = new Set<string>()
    const add = (url?: string | null) => {
      if (!url || seen.has(url)) return
      seen.add(url)
      candidates.push(url)
    }

    add(process.env.BRAIN_URL)
    if (process.env.BRAIN_PORT) add(`http://127.0.0.1:${process.env.BRAIN_PORT}`)
    if (reg?.brain?.url) add(reg.brain.url)
    if (reg?.brain?.port) add(`http://127.0.0.1:${reg.brain.port}`)
    add(`http://127.0.0.1:${BRAIN_PORT}`)

    for (let port = BRAIN_PORT; port <= BRAIN_PORT + 50; port += 1) {
      add(`http://127.0.0.1:${port}`)
    }

    for (const url of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await probeBrain(url)
      if (!ok) continue
      const port = Number(new URL(url).port)
      markRegistryReady('brain', port, url)
      return
    }
  }

  // 立即执行一次，并在后台持续更新 registry
  void run()
  setInterval(() => {
    void run()
  }, 2000)
}

function getDevWindowIcon() {
  if (!is.dev) return undefined
  return existsSync(DEV_ICON_PATH) ? DEV_ICON_PATH : undefined
}

function getMenuState() {
  const zoomFactor = getActiveWebContents()?.getZoomFactor() ?? 1
  return { zoomPercent: Math.round(zoomFactor * 100), mode: currentUiMode }
}

function resolveAppliedUiMode(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system'
    ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    : mode
}

function applyThemeMode(mode: ThemeMode, options?: { persist?: boolean }) {
  if (options?.persist !== false) {
    updateAppSettings({ themeMode: mode })
  }

  nativeTheme.themeSource = mode
  setBrowserViewTheme(mode)
  currentUiMode = resolveAppliedUiMode(mode)

  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('ui-mode-set', currentUiMode)
  })
}

function createWindow(): void {
  // 创建主窗口
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset', // Mac风格无边框
    trafficLightPosition: { x: 12, y: 12 },
    ...(getDevWindowIcon() ? { icon: getDevWindowIcon() } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  const window = mainWindow

  window.on('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  window.webContents.on('did-finish-load', () => {
    if (activeSessionId) {
      window.webContents.send('session-ready', activeSessionId)
    }
  })

  // 初始化浏览器视图管理器
  setupBrowserViews(window)
  registerUserDataActivityHandler((activity) => {
    const reason = activity?.reason ? `event:${activity.reason}` : 'event'
    scheduleUserDataSave(reason)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  window.on('minimize', () => {
    if (menuWindow && !menuWindow.isDestroyed()) {
      menuWindow.hide()
    }
  })

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })
}

function createMenuWindow(parent: BrowserWindow): BrowserWindow {
  const menu = new BrowserWindow({
    width: MENU_WIDTH,
    height: MENU_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    parent,
    ...(getDevWindowIcon() ? { icon: getDevWindowIcon() } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  menu.setAlwaysOnTop(true, 'pop-up-menu')

  menu.on('blur', () => {
    if (!menu.isDestroyed()) {
      menu.hide()
    }
  })

  menu.on('closed', () => {
    if (menuWindow === menu) {
      menuWindow = null
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    menu.loadURL(new URL('menu.html', process.env['ELECTRON_RENDERER_URL']).toString())
  } else {
    menu.loadFile(MENU_PAGE_PATH)
  }

  return menu
}

function createDownloadsWindow(parent?: BrowserWindow): BrowserWindow {
  const downloads = new BrowserWindow({
    width: 420,
    height: 520,
    show: false,
    title: '下载内容',
    resizable: true,
    autoHideMenuBar: true,
    parent,
    ...(getDevWindowIcon() ? { icon: getDevWindowIcon() } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  downloads.on('closed', () => {
    if (downloadsWindow === downloads) {
      downloadsWindow = null
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    downloads.loadURL(new URL('downloads.html', process.env['ELECTRON_RENDERER_URL']).toString())
  } else {
    downloads.loadFile(DOWNLOADS_PAGE_PATH)
  }

  return downloads
}

function openDownloadsWindow() {
  if (!mainWindow) return
  if (!downloadsWindow || downloadsWindow.isDestroyed()) {
    downloadsWindow = createDownloadsWindow(mainWindow)
  }
  downloadsWindow.show()
  downloadsWindow.focus()
}

function showNotImplemented(action: string) {
  const message = `${action} 功能还在开发中`
  const focused = BrowserWindow.getFocusedWindow()
  if (focused) {
    dialog.showMessageBox(focused, { type: 'info', message, buttons: ['知道了'] })
  } else {
    dialog.showMessageBox({ type: 'info', message, buttons: ['知道了'] })
  }
}

async function saveActivePageAs() {
  const wc = getActiveWebContents()
  const targetWindow = BrowserWindow.getFocusedWindow() ?? mainWindow
  if (!wc || !targetWindow) return

  const { canceled, filePath } = await dialog.showSaveDialog(targetWindow, {
    title: '保存页面为',
    defaultPath: 'page.html'
  })

  if (canceled || !filePath) return

  try {
    await wc.savePage(filePath, 'HTMLComplete')
  } catch (error) {
    await dialog.showMessageBox(targetWindow, {
      type: 'error',
      title: '保存失败',
      message: '页面保存失败，请检查权限或磁盘空间。',
      detail: String(error)
    })
  }
}

function createApplicationMenu() {
  const isMac = process.platform === 'darwin'
  if (!isMac) return
  const appName = app.getName()
  const menuItems = (...items: Electron.MenuItemConstructorOptions[]) => items

  const getZoom = () => getActiveWebContents()?.getZoomFactor() ?? 1
  const clampZoom = (value: number) => Math.min(5, Math.max(0.25, value))
  const setZoom = (factor: number) => {
    const wc = getActiveWebContents()
    if (wc) wc.setZoomFactor(clampZoom(factor))
  }

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: appName,
            submenu: menuItems(
              { role: 'about', label: `关于 ${appName}` },
              { type: 'separator' },
              {
                label: '设置...',
                accelerator: 'CmdOrCtrl+,',
                click: () => openTab('app://settings')
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            )
          }
        ]
      : []),
    {
      label: '文件',
      submenu: menuItems(
        {
          label: '新建标签页',
          accelerator: 'CmdOrCtrl+T',
          click: () => openTab()
        },
        {
          label: '新建窗口',
          accelerator: 'CmdOrCtrl+N',
          click: () => createWindow()
        },
        {
          label: '新建无痕窗口',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => openIncognitoWindow()
        },
        { type: 'separator' },
        {
          label: '关闭标签页',
          accelerator: 'CmdOrCtrl+W',
          click: () => closeActiveTab()
        },
        { role: 'close', label: '关闭窗口', accelerator: 'CmdOrCtrl+Shift+W' },
        { type: 'separator' },
        {
          label: '保存页面为...',
          accelerator: 'CmdOrCtrl+S',
          click: () => saveActivePageAs()
        },
        {
          label: '打印...',
          accelerator: 'CmdOrCtrl+P',
          click: () => getActiveWebContents()?.print({})
        }
      )
    },
    {
      label: '编辑',
      submenu: menuItems(
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        {
          label: '查找...',
          accelerator: 'CmdOrCtrl+F',
          click: () => showNotImplemented('查找')
        }
      )
    },
    {
      label: '查看',
      submenu: menuItems(
        {
          label: '重新加载',
          accelerator: 'CmdOrCtrl+R',
          click: () => getActiveWebContents()?.reload()
        },
        {
          label: '停止加载',
          accelerator: 'Esc',
          click: () => getActiveWebContents()?.stop()
        },
        { type: 'separator' },
        {
          label: '实际大小',
          accelerator: 'CmdOrCtrl+0',
          click: () => setZoom(1)
        },
        {
          label: '放大',
          accelerator: 'CmdOrCtrl+=',
          click: () => setZoom(getZoom() + 0.1)
        },
        {
          label: '缩小',
          accelerator: 'CmdOrCtrl+-',
          click: () => setZoom(getZoom() - 0.1)
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
        { type: 'separator' },
        {
          label: '开发者工具',
          accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: () => getActiveWebContents()?.openDevTools({ mode: 'detach' })
        }
      )
    },
    {
      label: '历史记录',
      submenu: menuItems(
        {
          label: '后退',
          accelerator: 'CmdOrCtrl+[',
          click: () => getActiveWebContents()?.goBack()
        },
        {
          label: '前进',
          accelerator: 'CmdOrCtrl+]',
          click: () => getActiveWebContents()?.goForward()
        },
        { type: 'separator' },
        {
          label: '历史记录',
          click: () => showNotImplemented('历史记录')
        },
        {
          label: '下载内容',
          accelerator: 'CmdOrCtrl+Shift+J',
          click: () => openDownloadsWindow()
        }
      )
    },
    {
      label: '书签',
      submenu: menuItems(
        {
          label: '书签管理器',
          click: () => showNotImplemented('书签管理')
        }
      )
    },
    {
      label: '窗口',
      role: 'window',
      submenu: menuItems(
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' }
      )
    },
    {
      label: '帮助',
      role: 'help',
      submenu: menuItems(
        {
          label: '关于',
          click: () => dialog.showMessageBox({ type: 'info', message: `${appName}` })
        }
      )
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

app.whenReady().then(async () => {
  // 1. 等待端口分配和进程启动
  await ProcessManager.startAll()
  const initialSettings = loadAppSettings()
  applyThemeMode(initialSettings.themeMode, { persist: false })

  ipcMain.on('ui-theme-set', (_, color: string) => {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('ui-theme-set', color)
    })
  })

  // 监听模式切换 (light/dark)
  ipcMain.on('ui-mode-set', (_, mode: ThemeMode) => {
    applyThemeMode(mode)
  })

  nativeTheme.on('updated', () => {
    if (nativeTheme.themeSource === 'system') {
      applyThemeMode('system', { persist: false })
    }
  })

  electronApp.setAppUserModelId('com.alphomi.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()
  teachingCaptureController = initializeTeachingCapture({
    getDriverBaseUrl: () => driverBaseUrl,
    getDriverSessionId: () => activeSessionId,
    sendToRenderer: broadcastToAllWindows,
  })
  createApplicationMenu()
  controlServer = startControlServer()
  registerInitialPorts()
  startBrainProbe()

  // 2. 等待 Driver 就绪并进行连接 (简单的轮询重试)
  waitForDriverAndConnect()

  // 3. 注册 IPC 处理程序，让前端获取 Brain 的地址
  ipcMain.handle('get-brain-url', () => {
    const fromEnv = process.env.BRAIN_WS_URL
    if (fromEnv) return fromEnv

    const reg = readRegistry()
    const port = reg?.brain?.port ?? BRAIN_PORT
    return `ws://127.0.0.1:${port}/ws/chat`
  })
  ipcMain.handle('downloads-get', () => {
    return getDownloads()
  })
  ipcMain.handle('downloads-action', (_, action: 'show' | 'open' | 'cancel', id: string) => {
    return downloadAction(action, id)
  })
  ipcMain.handle('settings-get', () => {
    return loadAppSettings()
  })
  ipcMain.handle('settings-update', (_, patch: Partial<AppSettings>) => {
    const next = updateAppSettings(patch)
    if (Object.prototype.hasOwnProperty.call(patch, 'themeMode')) {
      applyThemeMode(next.themeMode, { persist: false })
    }
    return next
  })
  ipcMain.handle('settings-tool-catalog', () => {
    return getToolCatalogSections()
  })
  ipcMain.handle('llm-settings-get', () => {
    return loadLLMSettings()
  })
  ipcMain.handle('llm-settings-update', (_, patch) => {
    return updateLLMSettings(patch || {})
  })
  ipcMain.handle('llm-settings-effective', (_, options?: { includeApiKey?: boolean }) => {
    return resolveEffectiveLLMSettings(options)
  })
  ipcMain.handle('llm-settings-test', (_, input) => {
    return testLLMConnection(input || {})
  })

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  ipcMain.on('menu-open', (event, anchor: { x: number; y: number; width: number; height: number }) => {
    const mainWindow = BrowserWindow.fromWebContents(event.sender)
    if (!mainWindow) return
    if (!menuWindow || menuWindow.isDestroyed() || menuWindow.getParentWindow() !== mainWindow) {
      menuWindow = createMenuWindow(mainWindow)
    }
    const [windowX, windowY] = mainWindow.getPosition()
    const [windowWidth, windowHeight] = mainWindow.getSize()

    const desiredX = Math.round(anchor.x + anchor.width - MENU_WIDTH)
    const desiredY = Math.round(anchor.y + anchor.height + 6)
    const minX = windowX + MENU_MARGIN
    const maxX = windowX + windowWidth - MENU_WIDTH - MENU_MARGIN
    const minY = windowY + MENU_MARGIN
    const maxY = windowY + windowHeight - MENU_HEIGHT - MENU_MARGIN

    const x = Math.min(Math.max(desiredX, minX), Math.max(minX, maxX))
    const y = Math.min(Math.max(desiredY, minY), Math.max(minY, maxY))

    menuWindow.setBounds({ x, y, width: MENU_WIDTH, height: MENU_HEIGHT })
    menuWindow.show()
    menuWindow.focus()
    menuWindow.webContents.send('menu-state', getMenuState())
  })

  ipcMain.handle('menu-get-state', () => {
    return getMenuState()
  })

  ipcMain.handle('menu-action', async (_, action: string) => {
    let closeMenu = true
    const wc = getActiveWebContents()

    const clampZoom = (value: number) => Math.min(5, Math.max(0.25, value))
    const setZoom = (factor: number) => {
      if (wc) wc.setZoomFactor(clampZoom(factor))
    }

    switch (action) {
      case 'new-tab':
        openTab()
        break
      case 'new-window':
        createWindow()
        break
      case 'history':
      case 'bookmarks':
      case 'find':
        console.log(`[Menu] Placeholder action: ${action}`)
        break
      case 'downloads':
        openDownloadsWindow()
        break
      case 'zoom-in': {
        closeMenu = false
        const next = clampZoom((wc?.getZoomFactor() ?? 1) + 0.1)
        setZoom(next)
        break
      }
      case 'zoom-out': {
        closeMenu = false
        const next = clampZoom((wc?.getZoomFactor() ?? 1) - 0.1)
        setZoom(next)
        break
      }
      case 'zoom-reset':
        closeMenu = false
        setZoom(1)
        break
      case 'toggle-fullscreen':
        closeMenu = false
        if (mainWindow) {
          mainWindow.setFullScreen(!mainWindow.isFullScreen())
        }
        break
      case 'print':
        wc?.print({})
        break
      case 'settings':
        openTab('app://settings')
        break
      case 'exit':
        app.quit()
        break
      default:
        console.log(`[Menu] Unknown action: ${action}`)
        break
    }

    const zoomFactor = wc?.getZoomFactor() ?? 1
    const zoomPercent = Math.round(zoomFactor * 100)

    if (closeMenu && menuWindow && !menuWindow.isDestroyed()) {
      menuWindow.hide()
    }

    return { zoomPercent, closeMenu }
  })
})

app.on('before-quit', (event) => {
  if (isQuitting) return
  const config = resolveUserDataConfig()
  if (!config.enabled) return
  if (!activeSessionId) return

  event.preventDefault()
  isQuitting = true
  stopAutoSave()

  const savePromise = persistUserData(activeSessionId, 'before-quit').catch(() => {})
  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(resolve, 3000)
  })

  Promise.race([savePromise, timeoutPromise]).finally(() => {
    app.quit()
  })
})

app.on('will-quit', () => {
  if (teachingCaptureController) {
    teachingCaptureController.dispose()
    teachingCaptureController = null
  }
  if (controlServer) {
    controlServer.close()
    controlServer = null
  }
  ProcessManager.killAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function startControlServer() {
  const sendJson = (res: http.ServerResponse, statusCode: number, payload: unknown) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  const readJsonBody = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  }

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1')

    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      sendJson(res, 200, { success: true, data: { status: 'ok', service: 'desktop-control' } })
      return
    }

    if (req.method === 'GET' && requestUrl.pathname === '/tabs/active') {
      const activeTab = getActiveTabInfo()
      sendJson(res, activeTab ? 200 : 404, { success: Boolean(activeTab), data: activeTab })
      return
    }

    if (req.method === 'GET' && requestUrl.pathname === '/llm/settings') {
      sendJson(res, 200, { success: true, data: loadLLMSettings() })
      return
    }

    if (req.method === 'GET' && requestUrl.pathname === '/llm/effective') {
      const includeApiKey = requestUrl.searchParams.get('includeApiKey') === '1'
      sendJson(res, 200, {
        success: true,
        data: resolveEffectiveLLMSettings({ includeApiKey })
      })
      return
    }

    if (req.method === 'POST' && requestUrl.pathname === '/llm/settings') {
      void (async () => {
        try {
          const payload = await readJsonBody(req)
          sendJson(res, 200, { success: true, data: updateLLMSettings(payload) })
        } catch (error) {
          sendJson(res, 400, {
            success: false,
            error: error instanceof Error ? error.message : 'Invalid JSON'
          })
        }
      })()
      return
    }

    if (req.method === 'POST' && requestUrl.pathname === '/llm/test') {
      void (async () => {
        try {
          const payload = await readJsonBody(req)
          sendJson(res, 200, { success: true, data: await testLLMConnection(payload) })
        } catch (error) {
          sendJson(res, 400, {
            success: false,
            error: error instanceof Error ? error.message : 'Invalid JSON'
          })
        }
      })()
      return
    }

    if (req.method === 'POST' && requestUrl.pathname === '/tabs/select') {
      void (async () => {
        try {
          const payload = await readJsonBody(req)
          let ok = false
          if (typeof payload.id === 'number') {
            ok = selectTabById(payload.id)
          } else if (typeof payload.index === 'number') {
            ok = selectTabByIndex(payload.index)
          }

          sendJson(res, ok ? 200 : 400, { success: ok })
        } catch {
          sendJson(res, 400, { success: false, error: 'Invalid JSON' })
        }
      })()
      return
    }

    res.writeHead(404)
    res.end()
  })

  server.listen(DESKTOP_CONTROL_PORT, '127.0.0.1', () => {
    console.log(`[Main] Control server listening on http://127.0.0.1:${DESKTOP_CONTROL_PORT}`)
    markRegistryReady('desktopControl', DESKTOP_CONTROL_PORT, `http://127.0.0.1:${DESKTOP_CONTROL_PORT}`)
  })

  server.on('error', (err) => {
    console.error('[Main] Control server error:', err)
  })

  return server
}

// 核心连接逻辑
async function waitForDriverAndConnect() {
  let driverUrl = resolveInitialDriverUrl()
  const maxRetries = 120
  let retries = 0
  let isAttached = false // 防止重复 attach
  let isAttaching = false // 防止并发 attach
  let isDiscovering = false

  driverBaseUrl = driverUrl

  console.log(`[Main] Targeting Driver at: ${driverUrl}`)

  const refreshDriverTarget = async (reason: string) => {
    if (isDiscovering || isAttached) return
    isDiscovering = true
    try {
      const discovered = await discoverDriverUrl()
      if (discovered !== driverUrl) {
        console.log(`[Main] Driver target updated (${reason}): ${discovered}`)
        driverUrl = discovered
        driverBaseUrl = discovered
      }
    } catch (error) {
      console.warn('[Main] Driver rediscovery failed:', error)
    } finally {
      isDiscovering = false
    }
  }

  // 后台发现真实 Driver，不阻塞 attach 重试
  void refreshDriverTarget('startup')

  const interval = setInterval(async () => {
    if (isAttached) {
      clearInterval(interval)
      return
    }
    if (isAttaching) {
      return
    }

    retries++
    isAttaching = true
    try {
      // 检查 Driver 是否存活
      await axios.get(`${driverUrl}/health`, { timeout: 1000 })
      markRegistryReady('driver', Number(new URL(driverUrl).port), driverUrl)

      console.log('[Main] Driver is online, attaching CDP...')

      // 调用 Attach
      const attachRes = await axios.post(`${driverUrl}/sessions/attach`, {
        cdpEndpoint: `http://localhost:${CDP_PORT}`
      })

      if (attachRes.data.success) {
        isAttached = true // 标记为已连接，防止重复
        clearInterval(interval) // 清除定时器

        const sessionId = attachRes.data.data.sessionId
        console.log(`[Main] Attached! Session ID: ${sessionId}`)
        writeRegistry({ sessionId })
        activeSessionId = sessionId

        // 设置 sessionId 到 browser-view 模块
        setSessionId(sessionId)

        // 广播给所有窗口
        broadcastToAllWindows('session-ready', sessionId)

        if (teachingCaptureController) {
          teachingCaptureController.onDriverSessionReady()
        }

        await restoreUserData(sessionId)
        startAutoSave(sessionId)
      }
    } catch (e) {
      if (retries > maxRetries) {
        clearInterval(interval)
        console.error('[Main] Failed to connect to Driver after multiple retries')
      }
      // 每隔几次尝试重新发现一次，提升端口漂移场景的容错
      if (retries % 5 === 0) {
        void refreshDriverTarget(`retry-${retries}`)
      }
    } finally {
      isAttaching = false
    }
  }, 1000)
}
