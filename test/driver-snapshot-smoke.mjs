import process from 'node:process'

const baseUrl = process.env.DRIVER_URL || 'http://127.0.0.1:13000'
const requireDriver = process.env.REQUIRE_DRIVER_SMOKE === '1' || process.env.CI === 'true'

async function request(method, path, body) {
  const url = `${baseUrl}${path}`
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.success === false) {
    throw new Error(`Request failed ${method} ${path}: ${JSON.stringify(data)}`)
  }
  return data.data ?? data
}

async function ensureDriverReady() {
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(2000)
    })
    if (!res.ok) {
      throw new Error(`health returned ${res.status}`)
    }
    return true
  } catch (error) {
    const message =
      `[smoke] Driver is not reachable at ${baseUrl}. ` +
      'Start it with `pnpm --filter @alphomi/driver dev` or run `pnpm smoke`.'

    if (requireDriver) {
      throw new Error(`${message}\n${String(error)}`)
    }

    console.log(`${message}\n[smoke] skipping snapshot smoke test.`)
    return false
  }
}

function assertValidSnapshot(snapshot, expectedText) {
  if (typeof snapshot !== 'string' || snapshot.trim().length === 0) {
    throw new Error('Snapshot response is empty')
  }
  if (snapshot.includes('Error capturing snapshot:')) {
    throw new Error(`Snapshot contains runtime error:\n${snapshot}`)
  }
  if (expectedText && !snapshot.includes(expectedText)) {
    throw new Error(`Snapshot does not include expected text "${expectedText}"`)
  }
}

async function main() {
  console.log(`[smoke] Using Driver at ${baseUrl}`)
  const ready = await ensureDriverReady()
  if (!ready) return

  const session = await request('POST', '/sessions', { headless: true })
  const sessionId = session.sessionId
  if (!sessionId) throw new Error('Missing sessionId')

  try {
    await request('POST', `/sessions/${sessionId}/tools/browser_navigate`, { url: 'https://example.com' })
    const snapshotResult = await request('POST', `/sessions/${sessionId}/tools/browser_snapshot`, {})
    assertValidSnapshot(snapshotResult.snapshot, 'Example Domain')
    console.log('[smoke] snapshot smoke passed')
  } finally {
    await request('DELETE', `/sessions/${sessionId}`).catch(() => {})
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
