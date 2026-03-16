import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'

const rootDir = path.resolve(new URL('..', import.meta.url).pathname)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForHealth(url, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch {}
    await sleep(500)
  }
  throw new Error(`Driver did not become healthy at ${url}`)
}

async function request(baseUrl, method, requestPath, body, { allowFailure = false } = {}) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await response.json().catch(() => ({}))
  if (!allowFailure && (!response.ok || data.success === false)) {
    throw new Error(`Request failed ${method} ${requestPath}: ${JSON.stringify(data)}`)
  }
  return { status: response.status, body: data }
}

function writeToolSettings(filePath, tools) {
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        tools
      },
      null,
      2
    ),
    'utf8'
  )
}

async function main() {
  const driverPort = 13110 + Math.floor(Math.random() * 1000)
  const baseUrl = `http://127.0.0.1:${driverPort}`
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alphomi-tool-settings-'))
  const toolSettingsPath = path.join(tempDir, 'tool-settings.json')
  writeToolSettings(toolSettingsPath, {
    browser_snapshot: false,
    browser_inspect_visual: false
  })

  const driver = spawn('pnpm', ['--filter', '@alphomi/driver', 'dev'], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(driverPort),
      ALPHOMI_TOOL_SETTINGS_PATH: toolSettingsPath
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  })

  let stdout = ''
  let stderr = ''
  driver.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  driver.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  try {
    await waitForHealth(baseUrl)

    const listed = await request(baseUrl, 'GET', '/tools')
    const toolNames = (listed.body?.data?.tools || []).map((tool) => tool.name)
    if (toolNames.includes('browser_snapshot')) {
      throw new Error('Disabled tool browser_snapshot should not appear in the default /tools response')
    }

    const fullCatalog = await request(baseUrl, 'GET', '/tools?includeDisabled=1')
    const snapshotTool = (fullCatalog.body?.data?.tools || []).find((tool) => tool.name === 'browser_snapshot')
    if (!snapshotTool || snapshotTool.enabled !== false) {
      throw new Error('browser_snapshot should be present with enabled=false in /tools?includeDisabled=1')
    }

    const session = await request(baseUrl, 'POST', '/sessions', { headless: true })
    const sessionId = session.body?.data?.sessionId
    if (!sessionId) {
      throw new Error('Missing sessionId from driver')
    }

    try {
      const denied = await request(
        baseUrl,
        'POST',
        `/sessions/${sessionId}/tools/browser_snapshot`,
        {},
        { allowFailure: true }
      )
      if (denied.status !== 403) {
        throw new Error(`Disabled tool should return 403, got ${denied.status}`)
      }

      await sleep(20)
      writeToolSettings(toolSettingsPath, {
        browser_snapshot: true,
        browser_inspect_visual: true
      })
      await sleep(80)

      const listedAfterEnable = await request(baseUrl, 'GET', '/tools')
      const enabledNames = (listedAfterEnable.body?.data?.tools || []).map((tool) => tool.name)
      if (!enabledNames.includes('browser_snapshot')) {
        throw new Error('browser_snapshot should reappear in /tools after enabling it')
      }

      await request(baseUrl, 'POST', `/sessions/${sessionId}/tools/browser_navigate`, { url: 'https://example.com' })
      const snapshotResult = await request(baseUrl, 'POST', `/sessions/${sessionId}/tools/browser_snapshot`, {})
      const snapshot = snapshotResult.body?.data?.snapshot
      if (typeof snapshot !== 'string' || !snapshot.includes('Example Domain')) {
        throw new Error('Enabled browser_snapshot should succeed and include the Example Domain page snapshot')
      }
    } finally {
      await request(baseUrl, 'DELETE', `/sessions/${sessionId}`, undefined, { allowFailure: true })
    }

    console.log('[smoke] tool settings driver smoke passed')
  } finally {
    try {
      process.kill(-driver.pid, 'SIGTERM')
    } catch {
      driver.kill('SIGTERM')
    }
    await new Promise((resolve) => {
      driver.once('exit', () => resolve(undefined))
      setTimeout(() => resolve(undefined), 3000)
    })
    fs.rmSync(tempDir, { recursive: true, force: true })
    if (driver.exitCode && driver.exitCode !== 0) {
      console.error(stdout)
      console.error(stderr)
      throw new Error(`Driver process exited with code ${driver.exitCode}`)
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
