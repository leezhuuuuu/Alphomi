import { app } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import { is } from '@electron-toolkit/utils'
import { existsSync } from 'fs'
import { resolveSharedToolSettingsPath } from './tool-settings'

// 开发环境固定端口，生产环境才动态分配
export const DRIVER_PORT = 13000  // 🟢 改为高位端口避免冲突
export const BRAIN_PORT = 18000   // 🟢 改为高位端口避免冲突
export const DESKTOP_CONTROL_PORT = parseInt(process.env.DESKTOP_CONTROL_PORT || '13001', 10)

function getRegistryPath(): string {
  if (process.env.PORT_REGISTRY_PATH) {
    return process.env.PORT_REGISTRY_PATH
  }
  if (is.dev || !app.isReady()) {
    return path.join(process.cwd(), 'temp', 'ports.json')
  }
  return path.join(app.getPath('userData'), 'ports.json')
}

export class ProcessManager {
  private static driverProcess: ChildProcess | null = null
  private static brainProcess: ChildProcess | null = null

  static async startAll() {
    // 🟢 核心修改：如果是开发环境，直接返回，不启动子进程！
    // 因为 Turbo 已经在终端里帮我们启动了
    if (is.dev) {
      console.log('[ProcessManager] Dev mode detected. Skipping child process spawn. Assuming Turbo handles them.')
      return
    }

    // --- 以下是生产环境 (Production) 的逻辑 ---
    // 只有打包后运行，才由 Electron 负责启动子进程
    console.log('[ProcessManager] Production mode. Spawning child processes...')
    this.startDriver()
    this.startBrain()
  }

  static killAll() {
    // 开发环境不需要杀，Turbo 会处理
    if (is.dev) return

    if (this.driverProcess) {
      this.driverProcess.kill()
      this.driverProcess = null
    }
    if (this.brainProcess) {
      this.brainProcess.kill()
      this.brainProcess = null
    }
  }

  private static startDriver() {
    // 开发环境下，直接用 ts-node 启动源码 (为了方便)
    // 生产环境下，应该启动编译后的 JS
    const driverPath = is.dev
      ? path.join(__dirname, '../../../../apps/driver/src/server/index.ts')
      : path.join(app.getAppPath(), 'apps/driver/dist/server/index.js')

    console.log('[ProcessManager] Starting Driver at', driverPath)

    const cmd = is.dev ? 'npx' : process.execPath
    const args = is.dev
      ? ['ts-node', driverPath]
      : [driverPath]

    this.driverProcess = spawn(cmd, args, {
      env: {
        ...process.env,
        PORT: DRIVER_PORT.toString(),
        PORT_REGISTRY_PATH: getRegistryPath(),
        ALPHOMI_TOOL_SETTINGS_PATH: resolveSharedToolSettingsPath(),
        ...(is.dev
          ? {}
          : {
              ELECTRON_RUN_AS_NODE: '1',
              NODE_PATH: path.join(process.resourcesPath, 'app.asar', 'node_modules')
            })
      },
      cwd: is.dev ? path.join(__dirname, '../../../../apps/driver') : process.resourcesPath,
      shell: is.dev
    })

    this.driverProcess.stdout?.on('data', (data) => console.log(`[Driver] ${data}`))
    this.driverProcess.stderr?.on('data', (data) => console.error(`[Driver Err] ${data}`))
  }

  private static startBrain() {
    // Python 启动比较复杂，开发环境直接用 python
    // 生产环境需要打包成 exe/binary
    const brainBinaryPath = path.join(process.resourcesPath, 'brain/alphomi-brain')
    const brainSrcPath = is.dev
      ? path.join(__dirname, '../../../../apps/brain/src')
      : path.join(process.resourcesPath, 'brain', 'src')
    const brainCwd = is.dev ? path.join(__dirname, '../../../../apps/brain') : path.join(process.resourcesPath, 'brain')

    const env = {
      ...process.env,
      PORT: BRAIN_PORT.toString(), // 传入 Brain 的端口
      // 关键：告诉 Brain，Driver 在哪个端口
      PRAS_URL: `http://127.0.0.1:${DRIVER_PORT}`,
      PORT_REGISTRY_PATH: getRegistryPath(),
      ALPHOMI_TOOL_SETTINGS_PATH: resolveSharedToolSettingsPath(),
      BRAIN_RELOAD: is.dev ? '1' : '0',
      PYTHONPATH: brainSrcPath
    }

    if (!is.dev && existsSync(brainBinaryPath)) {
      console.log('[ProcessManager] Starting Brain binary at', brainBinaryPath)
      this.brainProcess = spawn(brainBinaryPath, [], {
        env,
        cwd: brainCwd,
        shell: false
      })
    } else {
      console.log('[ProcessManager] Starting Brain via Python module alphomi_brain.main')
      this.brainProcess = spawn('python3', ['-m', 'alphomi_brain.main'], {
        env,
        cwd: brainCwd,
        shell: is.dev
      })
    }

    this.brainProcess.stdout?.on('data', (data) => console.log(`[Brain] ${data}`))
    this.brainProcess.stderr?.on('data', (data) => console.error(`[Brain Err] ${data}`))
  }
}
