import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// 读取环境变量并应用深色模式
const themeMode = import.meta.env.VITE_THEME_MODE
if (themeMode === 'dark') {
  document.documentElement.classList.add('dark')
} else {
  document.documentElement.classList.remove('dark')
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)