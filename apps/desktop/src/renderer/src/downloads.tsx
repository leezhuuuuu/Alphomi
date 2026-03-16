import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { FolderOpen, Play, XCircle } from 'lucide-react'
import './index.css'

type ThemeMode = 'light' | 'dark' | 'system'

type DownloadEntry = {
  id: string
  url: string
  filename: string
  receivedBytes: number
  totalBytes: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  savePath?: string
  startedAt: number
}

function formatBytes(bytes: number) {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, index)
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
}

function resolveThemeMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark'
  }
  return mode === 'dark' ? 'dark' : 'light'
}

function DownloadsApp() {
  const [downloads, setDownloads] = useState<DownloadEntry[]>([])

  const loadDownloads = async () => {
    const list = await window.api.getDownloads()
    setDownloads(list)
  }

  useEffect(() => {
    const applyMode = (mode: 'light' | 'dark') => {
      document.documentElement.classList.toggle('dark', mode === 'dark')
    }

    window.api
      .getSettings()
      .then(settings => {
        applyMode(resolveThemeMode(settings.themeMode))
      })
      .catch(() => {
        applyMode('light')
      })

    loadDownloads()
    const handleUpdate = () => loadDownloads()
    const handleMode = (_: unknown, mode: 'light' | 'dark') => {
      applyMode(mode)
    }
    window.electron.ipcRenderer.on('downloads-updated', handleUpdate)
    window.electron.ipcRenderer.on('ui-mode-set', handleMode)
    return () => {
      window.electron.ipcRenderer.removeAllListeners('downloads-updated')
      window.electron.ipcRenderer.removeAllListeners('ui-mode-set')
    }
  }, [])

  const runAction = async (action: 'show' | 'open' | 'cancel', id: string) => {
    await window.api.downloadAction(action, id)
  }

  return (
    <div className="h-screen w-screen bg-[#f1f3f4] p-4 text-[#202124] dark:bg-zinc-900 dark:text-zinc-100">
      <div className="mb-3 text-sm font-semibold">下载内容</div>
      <div className="space-y-2 overflow-y-auto">
        {downloads.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#dadce0] bg-white p-4 text-sm text-[#5f6368] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            暂无下载记录
          </div>
        ) : (
          downloads.map(item => {
            const progress = item.totalBytes > 0 ? Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100)) : 0
            return (
              <div
                key={item.id}
                className="rounded-lg border border-[#dadce0] bg-white p-3 shadow-sm dark:border-zinc-700 dark:bg-zinc-800"
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-medium">{item.filename}</div>
                    <div className="mt-0.5 text-[11px] text-[#5f6368] dark:text-zinc-400">
                      {item.state === 'progressing'
                        ? `${formatBytes(item.receivedBytes)} / ${formatBytes(item.totalBytes || item.receivedBytes)}`
                        : item.state}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => runAction('show', item.id)}
                      className="rounded-md p-1 text-[#5f6368] hover:bg-[#e8eaed] dark:text-zinc-300 dark:hover:bg-zinc-700"
                      title="在文件夹中显示"
                    >
                      <FolderOpen size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => runAction('open', item.id)}
                      className="rounded-md p-1 text-[#5f6368] hover:bg-[#e8eaed] dark:text-zinc-300 dark:hover:bg-zinc-700"
                      title="打开"
                    >
                      <Play size={14} />
                    </button>
                    {item.state === 'progressing' ? (
                      <button
                        type="button"
                        onClick={() => runAction('cancel', item.id)}
                        className="rounded-md p-1 text-[#5f6368] hover:bg-[#e8eaed] dark:text-zinc-300 dark:hover:bg-zinc-700"
                        title="取消"
                      >
                        <XCircle size={14} />
                      </button>
                    ) : null}
                  </div>
                </div>
                {item.state === 'progressing' ? (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#e8eaed] dark:bg-zinc-700">
                    <div
                      className="h-full rounded-full bg-[#1a73e8]"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <DownloadsApp />
  </React.StrictMode>
)
