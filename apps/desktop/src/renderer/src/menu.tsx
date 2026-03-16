import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import {
  Plus,
  Square,
  History,
  Download,
  Bookmark,
  ZoomIn,
  Printer,
  Search,
  Settings,
  LogOut,
  Minus,
  Maximize2
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import './index.css'

type MenuAction =
  | 'new-tab'
  | 'new-window'
  | 'history'
  | 'downloads'
  | 'bookmarks'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'toggle-fullscreen'
  | 'print'
  | 'find'
  | 'settings'
  | 'exit'

const iconClass = 'text-[#5f6368] dark:text-zinc-300'

function Divider() {
  return <div className="my-2 h-px bg-[#e2e4e8] dark:bg-white/10" />
}

function MenuItem({
  icon: Icon,
  label,
  shortcut,
  onClick
}: {
  icon: LucideIcon
  label: string
  shortcut?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[12px] text-[#202124] transition-colors hover:bg-[#eef1f5] dark:text-zinc-100 dark:hover:bg-[#3a3b3d]"
    >
      <Icon size={14} className={iconClass} />
      <span>{label}</span>
      {shortcut ? (
        <span className="ml-auto text-[10px] text-[#8a8f98] dark:text-zinc-500">
          {shortcut}
        </span>
      ) : null}
    </button>
  )
}

function MenuApp() {
  const [zoomPercent, setZoomPercent] = useState(100)

  const applyMode = (mode: 'light' | 'dark') => {
    document.documentElement.classList.toggle('dark', mode === 'dark')
  }

  const runAction = async (action: MenuAction) => {
    const result = await window.api.menuAction(action)
    if (typeof result?.zoomPercent === 'number') {
      setZoomPercent(result.zoomPercent)
    }
  }

  useEffect(() => {
    document.body.style.background = 'transparent'
    window.api.getMenuState().then((state) => {
      setZoomPercent(state.zoomPercent)
      applyMode(state.mode)
    })

    const handleMode = (_: unknown, mode: 'light' | 'dark') => {
      applyMode(mode)
    }
    const handleMenuState = (_: unknown, state: { zoomPercent: number; mode: 'light' | 'dark' }) => {
      setZoomPercent(state.zoomPercent)
      applyMode(state.mode)
    }
    window.electron.ipcRenderer.on('ui-mode-set', handleMode)
    window.electron.ipcRenderer.on('menu-state', handleMenuState)
    return () => {
      window.electron.ipcRenderer.removeAllListeners('ui-mode-set')
      window.electron.ipcRenderer.removeAllListeners('menu-state')
    }
  }, [])

  return (
    <div className="flex h-full w-full items-start justify-start p-0">
      <div
        className="box-border w-full rounded-[14px] border border-[#dfe3e8] bg-white p-1.5 dark:border-white/10 dark:bg-[#2b2c2f]"
        style={{ boxShadow: '0 12px 28px rgba(0,0,0,0.35)' }}
      >
        <MenuItem icon={Plus} label="打开新的标签页" shortcut="⌘T" onClick={() => runAction('new-tab')} />
        <MenuItem icon={Square} label="打开新的窗口" shortcut="⌘N" onClick={() => runAction('new-window')} />
        <Divider />
        <MenuItem icon={History} label="历史记录" onClick={() => runAction('history')} />
        <MenuItem icon={Download} label="下载内容" onClick={() => runAction('downloads')} />
        <MenuItem icon={Bookmark} label="书签" onClick={() => runAction('bookmarks')} />
        <Divider />
        <div className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-[12px] text-[#202124] dark:text-zinc-100">
          <ZoomIn size={14} className={iconClass} />
          <span>缩放</span>
          <div className="ml-auto flex items-center gap-1 rounded-full border border-[#dde1e6] bg-[#f8f9fa] px-1.5 py-0.5 dark:border-white/10 dark:bg-[#1f2022]">
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => runAction('zoom-out')}
              className="rounded-full p-1 text-[#5f6368] hover:bg-[#e8eaed] dark:text-zinc-400 dark:hover:bg-[#3a3b3d]"
            >
              <Minus size={12} />
            </button>
            <button
              type="button"
              aria-label="Reset zoom"
              onClick={() => runAction('zoom-reset')}
              className="min-w-[44px] rounded-md px-1 text-[10px] text-[#5f6368] hover:bg-[#e8eaed] dark:text-zinc-300 dark:hover:bg-[#3a3b3d]"
            >
              {zoomPercent}%
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => runAction('zoom-in')}
              className="rounded-full p-1 text-[#5f6368] hover:bg-[#e8eaed] dark:text-zinc-400 dark:hover:bg-[#3a3b3d]"
            >
              <Plus size={12} />
            </button>
            <button
              type="button"
              aria-label="Toggle fullscreen"
              onClick={() => runAction('toggle-fullscreen')}
              className="rounded-full p-1 text-[#5f6368] hover:bg-[#e8eaed] dark:text-zinc-400 dark:hover:bg-[#3a3b3d]"
            >
              <Maximize2 size={12} />
            </button>
          </div>
        </div>
        <MenuItem icon={Printer} label="打印..." shortcut="⌘P" onClick={() => runAction('print')} />
        <MenuItem icon={Search} label="查找..." shortcut="⌘F" onClick={() => runAction('find')} />
        <Divider />
        <MenuItem icon={Settings} label="设置" onClick={() => runAction('settings')} />
        <MenuItem icon={LogOut} label="退出" onClick={() => runAction('exit')} />
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <MenuApp />
  </React.StrictMode>
)
