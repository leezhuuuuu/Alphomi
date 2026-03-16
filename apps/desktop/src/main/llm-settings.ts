import { app, safeStorage } from 'electron'
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { readConfigSection } from './config-section'

export type LLMProviderType = 'openai_compatible'
export type LLMEndpointMode = 'auto' | 'chat_completions' | 'responses'
export type LLMValueSource = 'environment' | 'user' | 'config' | 'default' | 'unset'

export type LLMProviderProfile = {
  id: string
  label: string
  providerType: LLMProviderType
  baseUrl: string
  model: string
  endpointMode: LLMEndpointMode
}

export type LLMProviderProfileView = LLMProviderProfile & {
  hasApiKey: boolean
}

export type LLMProviderSettings = {
  activeProfileId: string | null
  profiles: LLMProviderProfile[]
}

export type LLMProviderSettingsView = {
  activeProfileId: string | null
  profiles: LLMProviderProfileView[]
}

export type EffectiveLLMSettings = {
  providerType: LLMProviderType
  activeProfileId: string | null
  activeProfileLabel: string | null
  baseUrl: string
  model: string
  endpointMode: LLMEndpointMode
  apiKey: string
  hasApiKey: boolean
  sources: {
    baseUrl: LLMValueSource
    model: LLMValueSource
    endpointMode: LLMValueSource
    apiKey: LLMValueSource
  }
}

export type LLMSettingsUpdateProfileInput = {
  id?: string
  label?: string
  providerType?: LLMProviderType
  baseUrl?: string
  model?: string
  endpointMode?: LLMEndpointMode
  apiKey?: string
}

export type LLMSettingsUpdateInput = {
  activeProfileId?: string | null
  profiles?: LLMSettingsUpdateProfileInput[]
}

export type LLMConnectionTestInput = Partial<Pick<EffectiveLLMSettings, 'baseUrl' | 'model' | 'endpointMode' | 'apiKey'>> & {
  profileId?: string | null
}

export type LLMConnectionTestResult = {
  ok: boolean
  statusCode: number | null
  latencyMs: number
  endpointMode: Exclude<LLMEndpointMode, 'auto'>
  requestUrl: string
  model: string
  preview: string
  error?: string
}

type StoredSecretEnvelope = {
  encryption: 'safeStorage' | 'plain'
  value: string
}

type StoredSecretsPayload = {
  version: number
  secrets: Record<string, StoredSecretEnvelope>
}

const SETTINGS_FILENAME = 'llm-settings.json'
const SECRETS_FILENAME = 'llm-secrets.json'
const DEFAULT_MODEL = 'glm-4'
const DEFAULT_ENDPOINT_MODE: LLMEndpointMode = 'auto'

let cachedSettings: LLMProviderSettings | null = null
let cachedSecrets: Record<string, StoredSecretEnvelope> | null = null

function trimOptionalString(value: unknown): string {
  return String(value ?? '').trim()
}

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function getSettingsPath(): string {
  const fromEnv = process.env.ALPHOMI_LLM_SETTINGS_PATH?.trim()
  if (fromEnv) {
    return path.resolve(fromEnv)
  }
  return path.join(app.getPath('userData'), SETTINGS_FILENAME)
}

function getSecretsPath(): string {
  const fromEnv = process.env.ALPHOMI_LLM_SECRETS_PATH?.trim()
  if (fromEnv) {
    return path.resolve(fromEnv)
  }
  return path.join(app.getPath('userData'), SECRETS_FILENAME)
}

function normalizeProviderType(value: unknown): LLMProviderType {
  return value === 'openai_compatible' ? 'openai_compatible' : 'openai_compatible'
}

function normalizeEndpointMode(value: unknown): LLMEndpointMode {
  if (value === 'chat_completions' || value === 'responses') {
    return value
  }
  return 'auto'
}

function sanitizeProfileId(value: unknown): string {
  const raw = trimOptionalString(value)
  if (!raw) {
    return crypto.randomUUID()
  }
  return raw
}

function normalizeProfile(input: LLMSettingsUpdateProfileInput | Partial<LLMProviderProfile>): LLMProviderProfile {
  const baseUrl = trimOptionalString(input.baseUrl)
  const model = trimOptionalString(input.model) || DEFAULT_MODEL
  const label = trimOptionalString(input.label) || model || baseUrl || 'LLM Profile'
  return {
    id: sanitizeProfileId(input.id),
    label,
    providerType: normalizeProviderType(input.providerType),
    baseUrl,
    model,
    endpointMode: normalizeEndpointMode(input.endpointMode)
  }
}

function sanitizeSettings(value: unknown): LLMProviderSettings {
  if (!value || typeof value !== 'object') {
    return { activeProfileId: null, profiles: [] }
  }

  const record = value as Partial<LLMProviderSettings>
  const rawProfiles = Array.isArray(record.profiles) ? record.profiles : []
  const seen = new Set<string>()
  const profiles = rawProfiles
    .map((profile) => normalizeProfile(profile || {}))
    .filter((profile) => {
      if (seen.has(profile.id)) {
        return false
      }
      seen.add(profile.id)
      return true
    })

  const activeProfileId =
    typeof record.activeProfileId === 'string' && profiles.some((profile) => profile.id === record.activeProfileId)
      ? record.activeProfileId
      : profiles[0]?.id ?? null

  return {
    activeProfileId,
    profiles
  }
}

function loadSecretFile(): Record<string, StoredSecretEnvelope> {
  if (cachedSecrets) {
    return cachedSecrets
  }

  const filePath = getSecretsPath()
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as StoredSecretsPayload
    const secrets = parsed && typeof parsed === 'object' && parsed.secrets && typeof parsed.secrets === 'object'
      ? parsed.secrets
      : {}
    cachedSecrets = Object.fromEntries(
      Object.entries(secrets).filter((entry): entry is [string, StoredSecretEnvelope] => {
        const value = entry[1]
        return Boolean(value && typeof value === 'object' && typeof value.value === 'string')
      })
    )
  } catch {
    cachedSecrets = {}
  }

  return cachedSecrets
}

function saveSecretFile(nextSecrets: Record<string, StoredSecretEnvelope>) {
  const filePath = getSecretsPath()
  ensureDir(filePath)
  const payload: StoredSecretsPayload = {
    version: 1,
    secrets: nextSecrets
  }
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
  cachedSecrets = nextSecrets
}

function encryptSecret(value: string): StoredSecretEnvelope {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(value).toString('base64')
    return { encryption: 'safeStorage', value: encrypted }
  }
  return { encryption: 'plain', value: Buffer.from(value, 'utf8').toString('base64') }
}

function decryptSecret(envelope: StoredSecretEnvelope | undefined): string {
  if (!envelope || !envelope.value) {
    return ''
  }

  try {
    if (envelope.encryption === 'safeStorage') {
      return safeStorage.decryptString(Buffer.from(envelope.value, 'base64'))
    }
    return Buffer.from(envelope.value, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

function getSecretForProfile(profileId: string | null): string {
  if (!profileId) {
    return ''
  }
  const secrets = loadSecretFile()
  return decryptSecret(secrets[profileId])
}

function saveProfileSecret(profileId: string, apiKey: string | undefined, nextSecrets: Record<string, StoredSecretEnvelope>) {
  if (apiKey === undefined) {
    return
  }

  const trimmed = trimOptionalString(apiKey)
  if (!trimmed) {
    delete nextSecrets[profileId]
    return
  }

  nextSecrets[profileId] = encryptSecret(trimmed)
}

function toView(settings: LLMProviderSettings): LLMProviderSettingsView {
  return {
    activeProfileId: settings.activeProfileId,
    profiles: settings.profiles.map((profile) => ({
      ...profile,
      hasApiKey: Boolean(getSecretForProfile(profile.id))
    }))
  }
}

export function loadLLMSettings(): LLMProviderSettingsView {
  if (cachedSettings) {
    return toView(cachedSettings)
  }

  const filePath = getSettingsPath()
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    cachedSettings = sanitizeSettings(JSON.parse(raw))
  } catch {
    cachedSettings = { activeProfileId: null, profiles: [] }
  }

  return toView(cachedSettings)
}

export function updateLLMSettings(update: LLMSettingsUpdateInput): LLMProviderSettingsView {
  const current = cachedSettings ?? sanitizeSettings(loadLLMSettings())
  const nextSecrets = { ...loadSecretFile() }
  const normalizedUpdates = Array.isArray(update.profiles)
    ? update.profiles.map((profile) => ({
        profile: normalizeProfile(profile),
        apiKey: profile.apiKey
      }))
    : null

  const nextProfiles = normalizedUpdates ? normalizedUpdates.map((entry) => entry.profile) : current.profiles

  if (normalizedUpdates) {
    const nextProfileIds = new Set(nextProfiles.map((profile) => profile.id))
    for (const entry of normalizedUpdates) {
      saveProfileSecret(entry.profile.id, entry.apiKey, nextSecrets)
    }
    for (const existingId of Object.keys(nextSecrets)) {
      if (!nextProfileIds.has(existingId)) {
        delete nextSecrets[existingId]
      }
    }
  }

  const nextActiveProfileId = (() => {
    if (Object.prototype.hasOwnProperty.call(update, 'activeProfileId')) {
      const requested = update.activeProfileId
      if (requested && nextProfiles.some((profile) => profile.id === requested)) {
        return requested
      }
      return nextProfiles[0]?.id ?? null
    }
    if (current.activeProfileId && nextProfiles.some((profile) => profile.id === current.activeProfileId)) {
      return current.activeProfileId
    }
    return nextProfiles[0]?.id ?? null
  })()

  const nextSettings: LLMProviderSettings = {
    activeProfileId: nextActiveProfileId,
    profiles: nextProfiles
  }

  const filePath = getSettingsPath()
  ensureDir(filePath)
  fs.writeFileSync(filePath, JSON.stringify(nextSettings, null, 2), { encoding: 'utf8', mode: 0o600 })
  saveSecretFile(nextSecrets)
  cachedSettings = nextSettings
  return toView(nextSettings)
}

function nonEmptyEnvValue(key: string): string | null {
  const value = process.env[key]
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function nonEmptyConfigValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  const trimmed = trimOptionalString(value)
  return trimmed || null
}

export function resolveEffectiveLLMSettings(options?: { includeApiKey?: boolean }): EffectiveLLMSettings {
  const settings = cachedSettings ?? sanitizeSettings(loadLLMSettings())
  const activeProfile =
    settings.profiles.find((profile) => profile.id === settings.activeProfileId) ??
    settings.profiles[0] ??
    null
  const activeSecret = getSecretForProfile(activeProfile?.id ?? null)
  const { section } = readConfigSection('brain')

  const envBaseUrl = nonEmptyEnvValue('LLM_BASE_URL')
  const envModel = nonEmptyEnvValue('LLM_MODEL')
  const envEndpointMode = nonEmptyEnvValue('LLM_ENDPOINT_MODE')
  const envApiKey = nonEmptyEnvValue('LLM_API_KEY')

  const configBaseUrl = nonEmptyConfigValue(section, 'LLM_BASE_URL')
  const configModel = nonEmptyConfigValue(section, 'LLM_MODEL')
  const configEndpointMode = nonEmptyConfigValue(section, 'LLM_ENDPOINT_MODE')
  const configApiKey = nonEmptyConfigValue(section, 'LLM_API_KEY')

  const baseUrl = envBaseUrl ?? activeProfile?.baseUrl ?? configBaseUrl ?? ''
  const model = envModel ?? activeProfile?.model ?? configModel ?? DEFAULT_MODEL
  const endpointMode = normalizeEndpointMode(envEndpointMode ?? activeProfile?.endpointMode ?? configEndpointMode)
  const apiKey = envApiKey ?? activeSecret ?? configApiKey ?? ''

  return {
    providerType: activeProfile?.providerType ?? 'openai_compatible',
    activeProfileId: activeProfile?.id ?? null,
    activeProfileLabel: activeProfile?.label ?? null,
    baseUrl,
    model,
    endpointMode,
    apiKey: options?.includeApiKey ? apiKey : '',
    hasApiKey: Boolean(apiKey),
    sources: {
      baseUrl: envBaseUrl ? 'environment' : activeProfile?.baseUrl ? 'user' : configBaseUrl ? 'config' : 'unset',
      model: envModel ? 'environment' : activeProfile?.model ? 'user' : configModel ? 'config' : 'default',
      endpointMode: envEndpointMode
        ? 'environment'
        : activeProfile?.endpointMode
          ? 'user'
          : configEndpointMode
            ? 'config'
            : 'default',
      apiKey: envApiKey ? 'environment' : activeSecret ? 'user' : configApiKey ? 'config' : 'unset'
    }
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return trimOptionalString(baseUrl).replace(/\/+$/, '')
}

function resolveRequestTarget(
  baseUrl: string,
  endpointMode: LLMEndpointMode
): { requestUrl: string; endpointMode: Exclude<LLMEndpointMode, 'auto'> } {
  const normalizedBase = normalizeBaseUrl(baseUrl)
  const lowered = normalizedBase.toLowerCase()

  const stripKnownSuffix = () => {
    if (lowered.endsWith('/chat/completions')) {
      return normalizedBase.slice(0, -'/chat/completions'.length)
    }
    if (lowered.endsWith('/responses')) {
      return normalizedBase.slice(0, -'/responses'.length)
    }
    return normalizedBase
  }

  if (endpointMode === 'chat_completions') {
    const root = stripKnownSuffix()
    return { endpointMode: 'chat_completions', requestUrl: `${root}/chat/completions` }
  }

  if (endpointMode === 'responses') {
    const root = stripKnownSuffix()
    return { endpointMode: 'responses', requestUrl: `${root}/responses` }
  }

  if (lowered.endsWith('/responses')) {
    return { endpointMode: 'responses', requestUrl: normalizedBase }
  }
  if (lowered.endsWith('/chat/completions')) {
    return { endpointMode: 'chat_completions', requestUrl: normalizedBase }
  }

  return { endpointMode: 'chat_completions', requestUrl: `${normalizedBase}/chat/completions` }
}

function buildConnectionTestPayload(
  endpointMode: Exclude<LLMEndpointMode, 'auto'>,
  model: string
): Record<string, unknown> {
  if (endpointMode === 'responses') {
    return {
      model,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Reply with PONG only.' }]
        }
      ],
      max_output_tokens: 16
    }
  }

  return {
    model,
    messages: [{ role: 'user', content: 'Reply with PONG only.' }],
    max_tokens: 16,
    temperature: 0
  }
}

function extractPreview(endpointMode: Exclude<LLMEndpointMode, 'auto'>, payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return ''
  }

  const record = payload as Record<string, unknown>
  if (endpointMode === 'responses') {
    const output = Array.isArray(record.output) ? record.output : []
    for (const item of output) {
      if (!item || typeof item !== 'object') continue
      const content = Array.isArray((item as Record<string, unknown>).content)
        ? ((item as Record<string, unknown>).content as Array<Record<string, unknown>>)
        : []
      for (const block of content) {
        const text = trimOptionalString(block.text)
        if (text) return text
      }
    }
    return ''
  }

  const choices = Array.isArray(record.choices) ? record.choices : []
  const message = choices[0] && typeof choices[0] === 'object'
    ? ((choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined)
    : undefined
  return trimOptionalString(message?.content)
}

export async function testLLMConnection(input?: LLMConnectionTestInput): Promise<LLMConnectionTestResult> {
  const effective = resolveEffectiveLLMSettings({ includeApiKey: true })
  const settings = cachedSettings ?? sanitizeSettings(loadLLMSettings())
  const profile =
    input?.profileId
      ? settings.profiles.find((candidate) => candidate.id === input.profileId) ?? null
      : settings.profiles.find((candidate) => candidate.id === settings.activeProfileId) ?? settings.profiles[0] ?? null

  const merged: EffectiveLLMSettings = {
    ...effective,
    providerType: profile?.providerType ?? effective.providerType,
    activeProfileId: profile?.id ?? effective.activeProfileId,
    activeProfileLabel: profile?.label ?? effective.activeProfileLabel,
    baseUrl: trimOptionalString(input?.baseUrl) || effective.baseUrl,
    model: trimOptionalString(input?.model) || effective.model,
    endpointMode: normalizeEndpointMode(input?.endpointMode ?? effective.endpointMode),
    apiKey: trimOptionalString(input?.apiKey) || effective.apiKey,
    hasApiKey: Boolean(trimOptionalString(input?.apiKey) || effective.apiKey),
    sources: effective.sources
  }

  if (!merged.baseUrl) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: 0,
      endpointMode: 'chat_completions',
      requestUrl: '',
      model: merged.model,
      preview: '',
      error: 'LLM base URL is not configured.'
    }
  }

  if (!merged.apiKey) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: 0,
      endpointMode: 'chat_completions',
      requestUrl: '',
      model: merged.model,
      preview: '',
      error: 'LLM API key is not configured.'
    }
  }

  const target = resolveRequestTarget(merged.baseUrl, merged.endpointMode)
  const payload = buildConnectionTestPayload(target.endpointMode, merged.model)
  const startedAt = Date.now()

  try {
    const response = await axios.post(target.requestUrl, payload, {
      timeout: 12000,
      headers: {
        Authorization: `Bearer ${merged.apiKey}`,
        'Content-Type': 'application/json'
      }
    })

    return {
      ok: true,
      statusCode: response.status,
      latencyMs: Date.now() - startedAt,
      endpointMode: target.endpointMode,
      requestUrl: target.requestUrl,
      model: merged.model,
      preview: extractPreview(target.endpointMode, response.data)
    }
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      const details =
        trimOptionalString((error.response?.data as Record<string, unknown> | undefined)?.error) ||
        trimOptionalString((error.response?.data as Record<string, unknown> | undefined)?.message) ||
        error.message
      return {
        ok: false,
        statusCode: error.response?.status ?? null,
        latencyMs: Date.now() - startedAt,
        endpointMode: target.endpointMode,
        requestUrl: target.requestUrl,
        model: merged.model,
        preview: '',
        error: details || 'LLM connection test failed.'
      }
    }

    return {
      ok: false,
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      endpointMode: target.endpointMode,
      requestUrl: target.requestUrl,
      model: merged.model,
      preview: '',
      error: error instanceof Error ? error.message : 'LLM connection test failed.'
    }
  }
}
