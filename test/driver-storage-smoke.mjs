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

    console.log(`${message}\n[smoke] skipping storage smoke test.`)
    return false
  }
}

async function main() {
  console.log(`[smoke] Using Driver at ${baseUrl}`)
  const ready = await ensureDriverReady()
  if (!ready) return

  const session = await request('POST', '/sessions', { headless: true })
  const sessionId = session.sessionId
  if (!sessionId) throw new Error('Missing sessionId')

  await request('POST', `/sessions/${sessionId}/tools/browser_navigate`, { url: 'https://example.com' })
  const setResult = await request('POST', `/sessions/${sessionId}/tools/browser_evaluate`, {
    function: "() => { localStorage.setItem('smoke','1'); document.cookie='smoke=1; path=/'; return { ls: localStorage.getItem('smoke'), cookie: document.cookie }; }"
  })
  console.log('[smoke] setResult:', setResult.result)

  const state = await request('GET', `/sessions/${sessionId}/storageState?scope=active-only`)
  console.log('[smoke] exported origins:', state.visitedOrigins)

  const session2 = await request('POST', '/sessions', { headless: true })
  const sessionId2 = session2.sessionId
  if (!sessionId2) throw new Error('Missing sessionId2')

  await request('POST', `/sessions/${sessionId2}/storageState`, {
    cookies: state.cookies,
    localStorage: state.localStorage,
    mergePolicy: 'merge'
  })

  await request('POST', `/sessions/${sessionId2}/tools/browser_navigate`, { url: 'https://example.com' })
  const checkResult = await request('POST', `/sessions/${sessionId2}/tools/browser_evaluate`, {
    function: "() => ({ ls: localStorage.getItem('smoke'), cookie: document.cookie })"
  })
  console.log('[smoke] checkResult:', checkResult.result)

  await request('DELETE', `/sessions/${sessionId}`)
  await request('DELETE', `/sessions/${sessionId2}`)
  console.log('[smoke] done')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
